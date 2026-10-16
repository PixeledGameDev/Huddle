import crypto from "crypto";
import express, { Router } from "express";
import { pipeline } from "stream";
import { z } from "zod";
import { one, q, tx } from "./db";
import { cleanName, sniffImage } from "./fileutil";
import { isAllowedGif } from "./gifs";
import { getMessageDto, hydrate, messageSelect } from "./hydrate";
import { HttpError, h, rateLimit } from "./http";
import { assertCanWrite, channelServer, requireMember } from "./perms";
import { emitServer } from "./realtime";
import { deleteObject, getObject, putObject, r2Enabled, toNodeStream } from "./storage";

export const messagesRouter = Router();

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const MAX_DISTINCT_EMOJI = 20;
const SERVER_QUOTA_BYTES = Number(process.env.SERVER_STORAGE_MB ?? 250) * 1024 * 1024;
const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f]{1,16}$/u;

/** @username mentions resolve only to current members. @everyone needs an owner/admin. */
async function resolveMentions(serverId: string, content: string, isAdmin: boolean) {
  const names = new Set<string>();
  for (const m of content.matchAll(/(?<![\w@])@([A-Za-z0-9_]{3,20})(?!\w)/g)) names.add(m[1].toLowerCase());
  const everyone = names.delete("everyone") && isAdmin;
  if (!names.size) return { ids: [] as string[], everyone };
  const rows = await q<{ id: string }>(
    `select u.id from memberships m join users u on u.id = m.user_id where m.server_id = $1 and lower(u.username) = any($2::text[]) limit 20`,
    [serverId, [...names]]
  );
  return { ids: rows.map((r) => r.id), everyone };
}

messagesRouter.get("/channels/:channelId/messages", h(async (req, res) => {
  const serverId = await channelServer(req.params.channelId);
  await requireMember(serverId, req.user!.id);
  const before = z.coerce.number().int().positive().optional().parse(req.query.before);
  const rows = await q(`${messageSelect} where m.channel_id = $1 and ($2::bigint is null or m.id < $2::bigint) order by m.id desc limit 50`, [req.params.channelId, before ?? null]);
  res.json({ messages: await hydrate(rows.reverse(), req.user!.id), hasMore: rows.length === 50 });
}));

const sendSchema = z.object({
  content: z.string().trim().max(2000).default(""),
  attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).default([]),
  replyTo: z.string().regex(/^\d+$/).nullish(),
  gifUrl: z.string().max(500).nullish(),
});

messagesRouter.post("/channels/:channelId/messages", h(async (req, res) => {
  const user = req.user!;
  const { channelId } = req.params;
  const serverId = await channelServer(channelId);
  const me = await requireMember(serverId, user.id);
  rateLimit(`msg:${user.id}`, 6, 5000);
  const body = sendSchema.parse(req.body);
  const attachmentIds = [...new Set(body.attachmentIds)];
  const gifUrl = body.gifUrl ?? null;
  if (gifUrl && !isAllowedGif(gifUrl)) throw new HttpError(400, "That GIF source isn't supported.");
  if (!body.content && !attachmentIds.length && !gifUrl) throw new HttpError(400, "Write a message, attach a file, or pick a GIF.");
  await assertCanWrite(serverId, user.id);

  let replyAuthor: string | null = null;
  if (body.replyTo) {
    const r = await one<{ author_id: string }>(`select author_id from messages where id = $1::bigint and channel_id = $2`, [body.replyTo, channelId]);
    if (!r) throw new HttpError(400, "The message you're replying to no longer exists.");
    replyAuthor = r.author_id;
  }
  const { ids, everyone } = await resolveMentions(serverId, body.content, me.role !== "member");
  const notify = [...new Set([...ids, ...(replyAuthor ? [replyAuthor] : [])])].filter((id) => id !== user.id);

  const messageId = await tx(async (c) => {
    const row = await one<{ id: string }>(
      `insert into messages(channel_id, author_id, content, reply_to, mentions, mentions_everyone, gif_url)
       values ($1, $2, $3, $4::bigint, $5::uuid[], $6, $7) returning id::text as id`,
      [channelId, user.id, body.content, body.replyTo ?? null, notify, everyone, gifUrl],
      c
    );
    if (attachmentIds.length) {
      const linked = await q(
        `update attachments set message_id = $1::bigint
          where id = any($2::uuid[]) and uploader_id = $3 and channel_id = $4 and message_id is null returning id`,
        [row!.id, attachmentIds, user.id, channelId],
        c
      );
      if (linked.length !== attachmentIds.length) throw new HttpError(400, "One of the attached files is missing or was already sent.");
    }
    return row!.id;
  });
  const message = await getMessageDto(messageId, null);
  emitServer(serverId, "message.create", message);
  res.json({ message });
}));

// ---------- edit & delete ----------
const messageParam = (p: Record<string, string>) => z.string().regex(/^\d+$/, "Message not found.").parse(p.messageId);

async function messageContext(messageId: string) {
  const m = await one<any>(
    `select m.id::text as id, m.author_id, m.channel_id, m.content, m.gif_url, m.reply_to, c.server_id, s.is_dm,
            (select count(*) from attachments a where a.message_id = m.id)::int as files,
            exists(select 1 from polls p where p.message_id = m.id) as is_poll
       from messages m join channels c on c.id = m.channel_id join servers s on s.id = c.server_id where m.id = $1::bigint`,
    [messageId]
  );
  if (!m) throw new HttpError(404, "Message not found.");
  return m;
}

messagesRouter.patch("/messages/:messageId", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`edit:${user.id}`, 20, 60_000);
  const messageId = messageParam(req.params);
  const m = await messageContext(messageId);
  const me = await requireMember(m.server_id, user.id);
  if (m.author_id !== user.id) throw new HttpError(403, "You can only edit your own messages.");
  if (m.is_poll) throw new HttpError(400, "Polls can't be edited.");
  await assertCanWrite(m.server_id, user.id);
  const { content } = z.object({ content: z.string().trim().max(2000) }).parse(req.body);
  if (!content && !m.files && !m.gif_url) throw new HttpError(400, "A message can't be empty. Delete it instead.");
  if (content !== m.content) {
    const { ids, everyone } = await resolveMentions(m.server_id, content, me.role !== "member");
    let replyAuthor: string | null = null;
    if (m.reply_to) replyAuthor = (await one<{ author_id: string }>(`select author_id from messages where id = $1::bigint`, [m.reply_to]))?.author_id ?? null;
    const notify = [...new Set([...ids, ...(replyAuthor ? [replyAuthor] : [])])].filter((id) => id !== user.id);
    await q(`update messages set content = $2, edited_at = now(), mentions = $3::uuid[], mentions_everyone = $4 where id = $1::bigint`, [messageId, content, notify, everyone]);
  }
  const message = await getMessageDto(messageId, null);
  emitServer(m.server_id, "message.update", message);
  res.json({ message });
}));

messagesRouter.delete("/messages/:messageId", h(async (req, res) => {
  const user = req.user!;
  const messageId = messageParam(req.params);
  const m = await messageContext(messageId);
  const me = await requireMember(m.server_id, user.id);
  const isAdmin = me.role !== "member";
  if (m.author_id !== user.id && !isAdmin) throw new HttpError(403, "You can only delete your own messages.");
  await tx(async (c) => {
    // Archive for admins, then remove the real row so nobody else sees any trace of it. DMs have no admins, so nothing is kept.
    if (!m.is_dm)
      await q(
      `insert into deleted_messages(id, server_id, channel_id, channel_name, author_id, content, gif_url, created_at, attachments, meta, deleted_by)
       select m.id, c.server_id, m.channel_id, c.name, m.author_id, m.content, m.gif_url, m.created_at,
              (select coalesce(jsonb_agg(jsonb_build_object('name', a.name, 'mime', a.mime, 'size', a.size)), '[]'::jsonb) from attachments a where a.message_id = m.id),
              coalesce((select jsonb_build_object('poll', jsonb_build_object('question', p.question,
                         'options', (select jsonb_agg(o.text order by o.position) from poll_options o where o.poll_id = p.id)))
                          from polls p where p.message_id = m.id), '{}'::jsonb),
              $2
         from messages m join channels c on c.id = m.channel_id where m.id = $1::bigint`,
      [messageId, user.id],
      c
    );
    await q(`delete from messages where id = $1::bigint`, [messageId], c);
    if (m.author_id !== user.id)
      await q(`insert into audit_log(server_id, actor_id, target_id, action, detail) values ($1, $2, $3, 'message.delete', '{}')`, [m.server_id, user.id, m.author_id], c);
  });
  emitServer(m.server_id, "message.delete", { serverId: m.server_id, channelId: m.channel_id, messageId });
  res.json({ ok: true });
}));

// ---------- file uploads (stored in Postgres) ----------
messagesRouter.post(
  "/channels/:channelId/files",
  (req, _res, next) => {
    try { rateLimit(`upload:${req.user!.id}`, 10, 60_000); next(); } catch (e) { next(e); }
  },
  express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES }),
  h(async (req, res) => {
    const user = req.user!;
    const serverId = await channelServer(req.params.channelId);
    await requireMember(serverId, user.id);
    await assertCanWrite(serverId, user.id);
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, "That file is empty.");
    const name = cleanName(typeof req.query.name === "string" ? req.query.name : "file");
    const used = await one<{ n: string }>(`select coalesce(sum(a.size), 0)::text as n from attachments a join channels c on c.id = a.channel_id where c.server_id = $1`, [serverId]);
    if (Number(used!.n) + data.length > SERVER_QUOTA_BYTES) throw new HttpError(413, "This server has used up its file storage.");
    const mime = sniffImage(data) ?? "application/octet-stream";
    let attachment;
    if (r2Enabled) {
      const id = crypto.randomUUID();
      const key = `files/${id}`;
      try {
        await putObject(key, data, mime);
      } catch (e) {
        console.error(e);
        throw new HttpError(502, "File storage is unavailable right now. Try again in a moment.");
      }
      try {
        attachment = await one(
          `insert into attachments(id, channel_id, uploader_id, name, mime, size, storage_key) values ($1, $2, $3, $4, $5, $6, $7) returning id, name, mime, size`,
          [id, req.params.channelId, user.id, name, mime, data.length, key]
        );
      } catch (e) {
        deleteObject(key).catch(() => {});
        throw e;
      }
    } else {
      attachment = await one(
        `insert into attachments(channel_id, uploader_id, name, mime, size, data) values ($1, $2, $3, $4, $5, $6) returning id, name, mime, size`,
        [req.params.channelId, user.id, name, mime, data.length, data]
      );
    }
    res.json({ attachment });
  })
);

messagesRouter.get("/files/:fileId", h(async (req, res) => {
  const f = await one<any>(
    `select a.name, a.mime, a.size, a.data, a.storage_key, c.server_id from attachments a join channels c on c.id = a.channel_id where a.id = $1 and a.message_id is not null`,
    [req.params.fileId]
  );
  if (!f) throw new HttpError(404, "File not found.");
  await requireMember(f.server_id, req.user!.id);
  const inline = f.mime.startsWith("image/");
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Length", String(f.size));
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  if (f.storage_key) {
    if (!r2Enabled) throw new HttpError(503, "File storage isn't configured on this server.");
    const upstream = await getObject(f.storage_key);
    if (!upstream.ok || !upstream.body) {
      console.error(`R2 download failed for ${f.storage_key}: ${upstream.status}`);
      throw new HttpError(upstream.status === 404 ? 404 : 502, "That file can't be loaded right now.");
    }
    pipeline(toNodeStream(upstream.body), res, (err) => {
      if (err) res.destroy();
    });
    return;
  }
  if (!f.data) throw new HttpError(404, "File not found.");
  res.end(f.data);
}));

// ---------- reactions ----------
async function reactionContext(messageId: string, userId: string) {
  const m = await one<{ channel_id: string; server_id: string }>(
    `select m.channel_id, c.server_id from messages m join channels c on c.id = m.channel_id where m.id = $1::bigint`,
    [messageId]
  );
  if (!m) throw new HttpError(404, "Message not found.");
  await requireMember(m.server_id, userId);
  await assertCanWrite(m.server_id, userId);
  return m;
}
const reactionParams = (p: Record<string, string>) => ({
  messageId: z.string().regex(/^\d+$/, "Message not found.").parse(p.messageId),
  emoji: z.string().regex(EMOJI_RE, "That isn't an emoji.").parse(p.emoji),
});

messagesRouter.put("/messages/:messageId/reactions/:emoji", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`react:${user.id}`, 30, 10_000);
  const { messageId, emoji } = reactionParams(req.params);
  const m = await reactionContext(messageId, user.id);
  const stats = await one<{ n: number; has: boolean }>(
    `select count(distinct emoji)::int as n, coalesce(bool_or(emoji = $2), false) as has from reactions where message_id = $1::bigint`,
    [messageId, emoji]
  );
  if (!stats!.has && stats!.n >= MAX_DISTINCT_EMOJI) throw new HttpError(400, `A message can have at most ${MAX_DISTINCT_EMOJI} different reactions.`);
  const added = await q(`insert into reactions(message_id, user_id, emoji) values ($1::bigint, $2, $3) on conflict do nothing returning 1`, [messageId, user.id, emoji]);
  if (added.length) emitServer(m.server_id, "reaction.update", { serverId: m.server_id, channelId: m.channel_id, messageId, emoji, userId: user.id, added: true });
  res.json({ ok: true });
}));

messagesRouter.delete("/messages/:messageId/reactions/:emoji", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`react:${user.id}`, 30, 10_000);
  const { messageId, emoji } = reactionParams(req.params);
  const m = await reactionContext(messageId, user.id);
  const removed = await q(`delete from reactions where message_id = $1::bigint and user_id = $2 and emoji = $3 returning 1`, [messageId, user.id, emoji]);
  if (removed.length) emitServer(m.server_id, "reaction.update", { serverId: m.server_id, channelId: m.channel_id, messageId, emoji, userId: user.id, added: false });
  res.json({ ok: true });
}));
