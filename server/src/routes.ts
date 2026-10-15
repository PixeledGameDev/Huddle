import crypto from "crypto";
import express, { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { emitServer, isOnline, joinServerRooms, leaveServerRooms } from "./realtime";
import { listOpenVotes, voteRouter } from "./votes";

export const api = Router();
api.use(voteRouter);

type Role = "owner" | "admin" | "member";

async function membership(serverId: string, userId: string) {
  return one<{ role: Role; joined_at: Date }>(`select role, joined_at from memberships where server_id = $1 and user_id = $2`, [serverId, userId]);
}
async function requireMember(serverId: string, userId: string) {
  const m = await membership(serverId, userId);
  if (!m) throw new HttpError(403, "You're not in this server.");
  return m;
}
async function requireAdmin(serverId: string, userId: string) {
  const m = await requireMember(serverId, userId);
  if (m.role === "member") throw new HttpError(403, "Only owners and admins can do that.");
  return m;
}
async function timeoutUntil(serverId: string, userId: string) {
  const t = await one<{ until: Date }>(`select until from server_timeouts where server_id = $1 and user_id = $2 and until > now()`, [serverId, userId]);
  return t ? t.until.toISOString() : null;
}

const settingsColumns = {
  voteEnabled: "vote_enabled",
  voteAction: "vote_action",
  voteDurationSeconds: "vote_duration_seconds",
  voteThresholdPct: "vote_threshold_pct",
  voteMinVotes: "vote_min_votes",
  voteWindowSeconds: "vote_window_seconds",
  voteCooldownSeconds: "vote_cooldown_seconds",
  voteMinMemberAgeSeconds: "vote_min_member_age_seconds",
} as const;

const settingsSchema = z
  .object({
    voteEnabled: z.boolean(),
    voteAction: z.enum(["kick", "timeout", "ban"]),
    voteDurationSeconds: z.number().int().min(60).max(30 * 86400),
    voteThresholdPct: z.number().int().min(51).max(100),
    voteMinVotes: z.number().int().min(2).max(50),
    voteWindowSeconds: z.number().int().min(15).max(900),
    voteCooldownSeconds: z.number().int().min(0).max(86400),
    voteMinMemberAgeSeconds: z.number().int().min(0).max(30 * 86400),
  })
  .partial();

async function serverDetail(serverId: string, userId: string) {
  const s = await one<any>(`select * from servers where id = $1`, [serverId]);
  if (!s) throw new HttpError(404, "Server not found.");
  const me = await requireMember(serverId, userId);
  const channels = await q(`select id, name from channels where server_id = $1 order by created_at`, [serverId]);
  const members = (
    await q<any>(
      `select u.id, u.username, m.role, t.until as timeout_until
         from memberships m join users u on u.id = m.user_id
         left join server_timeouts t on t.server_id = m.server_id and t.user_id = m.user_id and t.until > now()
        where m.server_id = $1`,
      [serverId]
    )
  )
    .map((r) => ({ id: r.id, username: r.username, role: r.role as Role, online: isOnline(r.id), timeoutUntil: r.timeout_until ? new Date(r.timeout_until).toISOString() : null }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  const settings = Object.fromEntries(Object.entries(settingsColumns).map(([k, col]) => [k, s[col]]));
  return {
    id: s.id,
    name: s.name,
    ownerId: s.owner_id,
    myRole: me.role,
    myTimeoutUntil: await timeoutUntil(serverId, userId),
    channels,
    members,
    settings,
    votes: await listOpenVotes(serverId, userId),
  };
}

api.get("/servers", h(async (req, res) => {
  res.json({
    servers: await q(`select s.id, s.name from servers s join memberships m on m.server_id = s.id where m.user_id = $1 order by s.created_at`, [req.user!.id]),
  });
}));

api.post("/servers", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`mkserver:${user.id}`, 5, 3600_000);
  const { name } = z.object({ name: z.string().trim().min(1).max(40) }).parse(req.body);
  const server = await tx(async (c) => {
    const s = await one<{ id: string; name: string }>(`insert into servers(name, owner_id) values ($1, $2) returning id, name`, [name, user.id], c);
    await q(`insert into memberships(server_id, user_id, role) values ($1, $2, 'owner')`, [s!.id, user.id], c);
    await q(`insert into channels(server_id, name) values ($1, 'general')`, [s!.id], c);
    return s!;
  });
  joinServerRooms(user.id, server.id);
  res.json({ server });
}));

api.get("/servers/:serverId", h(async (req, res) => {
  res.json({ server: await serverDetail(req.params.serverId, req.user!.id) });
}));

api.post("/servers/:serverId/channels", h(async (req, res) => {
  const { serverId } = req.params;
  await requireAdmin(serverId, req.user!.id);
  const raw = z.object({ name: z.string().trim().min(1).max(30) }).parse(req.body).name;
  const name = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!name) throw new HttpError(400, "Channel names need letters or numbers.");
  const count = await one<{ n: number }>(`select count(*)::int as n from channels where server_id = $1`, [serverId]);
  if (count!.n >= 50) throw new HttpError(400, "This server has reached the 50 channel limit.");
  const channel = await one(`insert into channels(server_id, name) values ($1, $2) returning id, name`, [serverId, name]);
  emitServer(serverId, "channel.create", { serverId, channel });
  res.json({ channel });
}));

api.patch("/servers/:serverId/settings", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  await requireAdmin(serverId, user.id);
  const patch = settingsSchema.parse(req.body);
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined) as [keyof typeof settingsColumns, unknown][];
  if (!entries.length) throw new HttpError(400, "Nothing to update.");
  const sets = entries.map(([k], i) => `${settingsColumns[k]} = $${i + 2}`).join(", ");
  await q(`update servers set ${sets} where id = $1`, [serverId, ...entries.map(([, v]) => v)]);
  await q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, 'settings.update', $3)`, [serverId, user.id, JSON.stringify(patch)]);
  emitServer(serverId, "server.update", { serverId });
  res.json({ server: await serverDetail(serverId, user.id) });
}));

api.post("/servers/:serverId/invites", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  await requireMember(serverId, user.id);
  rateLimit(`invite:${user.id}`, 20, 3600_000);
  const code = crypto.randomBytes(6).toString("base64url");
  await q(`insert into invites(code, server_id, created_by) values ($1, $2, $3)`, [code, serverId, user.id]);
  res.json({ code });
}));

api.post("/join", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`join:${user.id}`, 20, 60_000);
  const { code } = z.object({ code: z.string().trim().min(1).max(64) }).parse(req.body);
  const inv = await one<{ server_id: string }>(`select server_id from invites where code = $1`, [code]);
  if (!inv) throw new HttpError(404, "That invite code isn't valid.");
  const ban = await one(`select 1 from server_bans where server_id = $1 and user_id = $2 and until > now()`, [inv.server_id, user.id]);
  if (ban) throw new HttpError(403, "You're banned from this server.");
  await q(`insert into memberships(server_id, user_id) values ($1, $2) on conflict do nothing`, [inv.server_id, user.id]);
  joinServerRooms(user.id, inv.server_id);
  emitServer(inv.server_id, "member.join", { serverId: inv.server_id, userId: user.id });
  res.json({ server: await one(`select id, name from servers where id = $1`, [inv.server_id]) });
}));

api.post("/servers/:serverId/leave", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  const m = await requireMember(serverId, user.id);
  if (m.role === "owner") throw new HttpError(400, "Owners can't leave their server.");
  await q(`delete from memberships where server_id = $1 and user_id = $2`, [serverId, user.id]);
  leaveServerRooms(user.id, serverId);
  emitServer(serverId, "member.leave", { serverId, userId: user.id });
  res.json({ ok: true });
}));

api.post("/servers/:serverId/members/:userId/role", h(async (req, res) => {
  const { serverId, userId } = req.params;
  const me = await requireMember(serverId, req.user!.id);
  if (me.role !== "owner") throw new HttpError(403, "Only the owner can change roles.");
  const { role } = z.object({ role: z.enum(["admin", "member"]) }).parse(req.body);
  const target = await requireMember(serverId, userId);
  if (target.role === "owner") throw new HttpError(400, "The owner's role can't change.");
  await q(`update memberships set role = $3 where server_id = $1 and user_id = $2`, [serverId, userId, role]);
  await q(`insert into audit_log(server_id, actor_id, target_id, action, detail) values ($1, $2, $3, 'role.update', $4)`, [serverId, req.user!.id, userId, JSON.stringify({ role })]);
  emitServer(serverId, "member.update", { serverId, userId });
  res.json({ ok: true });
}));

api.get("/servers/:serverId/audit", h(async (req, res) => {
  await requireAdmin(req.params.serverId, req.user!.id);
  const rows = await q<any>(
    `select a.id, a.action, a.detail, a.created_at, actor.username as actor, target.username as target
       from audit_log a left join users actor on actor.id = a.actor_id left join users target on target.id = a.target_id
      where a.server_id = $1 order by a.id desc limit 50`,
    [req.params.serverId]
  );
  res.json({ entries: rows.map((r) => ({ id: r.id, action: r.action, detail: r.detail, createdAt: r.created_at, actor: r.actor, target: r.target })) });
}));

async function channelServer(channelId: string) {
  const ch = await one<{ server_id: string }>(`select server_id from channels where id = $1`, [channelId]);
  if (!ch) throw new HttpError(404, "Channel not found.");
  return ch.server_id;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const MAX_DISTINCT_EMOJI = 20;
const SERVER_QUOTA_BYTES = Number(process.env.SERVER_STORAGE_MB ?? 250) * 1024 * 1024;
const EMOJI_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f]{1,16}$/u;

interface AttachmentDto { id: string; name: string; mime: string; size: number }
interface ReactionDto { emoji: string; userIds: string[] }

const messageSelect = `select m.id::text as id, m.channel_id, m.author_id, u.username as author_name, m.content, m.created_at
  from messages m join users u on u.id = m.author_id`;

/** Attach files and reactions to a batch of message rows (two queries, regardless of batch size). */
async function hydrate(rows: any[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const atts = await q<any>(
    `select id, message_id::text as message_id, name, mime, size from attachments
      where message_id = any($1::bigint[]) order by created_at, id`,
    [ids]
  );
  const reacts = await q<any>(
    `select message_id::text as message_id, emoji, array_agg(user_id order by created_at) as user_ids
       from reactions where message_id = any($1::bigint[]) group by message_id, emoji order by min(created_at)`,
    [ids]
  );
  return rows.map((r) => ({
    id: r.id as string,
    channelId: r.channel_id as string,
    authorId: r.author_id as string,
    authorName: r.author_name as string,
    content: r.content as string,
    createdAt: new Date(r.created_at).toISOString(),
    attachments: atts.filter((a) => a.message_id === r.id).map((a): AttachmentDto => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
    reactions: reacts.filter((x) => x.message_id === r.id).map((x): ReactionDto => ({ emoji: x.emoji, userIds: x.user_ids })),
  }));
}

api.get("/channels/:channelId/messages", h(async (req, res) => {
  const serverId = await channelServer(req.params.channelId);
  await requireMember(serverId, req.user!.id);
  const before = z.coerce.number().int().positive().optional().parse(req.query.before);
  const rows = await q(`${messageSelect} where m.channel_id = $1 and ($2::bigint is null or m.id < $2::bigint) order by m.id desc limit 50`, [req.params.channelId, before ?? null]);
  res.json({ messages: await hydrate(rows.reverse()), hasMore: rows.length === 50 });
}));

api.post("/channels/:channelId/messages", h(async (req, res) => {
  const user = req.user!;
  const serverId = await channelServer(req.params.channelId);
  await requireMember(serverId, user.id);
  rateLimit(`msg:${user.id}`, 6, 5000);
  const body = z
    .object({
      content: z.string().trim().max(2000).default(""),
      attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).default([]),
    })
    .parse(req.body);
  const attachmentIds = [...new Set(body.attachmentIds)];
  if (!body.content && !attachmentIds.length) throw new HttpError(400, "Write a message or attach a file.");
  const until = await timeoutUntil(serverId, user.id);
  if (until) throw new HttpError(403, "You're timed out in this server.", { timeoutUntil: until });

  const messageId = await tx(async (c) => {
    const row = await one<{ id: string }>(`insert into messages(channel_id, author_id, content) values ($1, $2, $3) returning id::text as id`, [req.params.channelId, user.id, body.content], c);
    if (attachmentIds.length) {
      // Only your own, still-unsent uploads from this channel can be attached.
      const linked = await q(
        `update attachments set message_id = $1::bigint
          where id = any($2::uuid[]) and uploader_id = $3 and channel_id = $4 and message_id is null returning id`,
        [row!.id, attachmentIds, user.id, req.params.channelId],
        c
      );
      if (linked.length !== attachmentIds.length) throw new HttpError(400, "One of the attached files is missing or was already sent.");
    }
    return row!.id;
  });
  const [message] = await hydrate(await q(`${messageSelect} where m.id = $1::bigint`, [messageId]));
  emitServer(serverId, "message.create", message);
  res.json({ message });
}));

// ---------- file uploads ----------
// Files are stored in Postgres (bytea) so this works on Render's ephemeral disk with no extra service.
// Upload is a separate raw-body request; the message then references the returned attachment ids.

/** Identify safe raster images by magic bytes. Anything else is stored as an opaque download. */
function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const head = b.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
const cleanName = (s: string) => s.replace(/[\\\/\u0000-\u001f"<>:*?|]+/g, "_").trim().slice(0, 120) || "file";

api.post(
  "/channels/:channelId/files",
  (req, _res, next) => {
    // Throttle before the body is read.
    try { rateLimit(`upload:${req.user!.id}`, 10, 60_000); next(); } catch (e) { next(e); }
  },
  express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES }),
  h(async (req, res) => {
    const user = req.user!;
    const serverId = await channelServer(req.params.channelId);
    await requireMember(serverId, user.id);
    if (await timeoutUntil(serverId, user.id)) throw new HttpError(403, "You're timed out in this server.");
    const data = req.body;
    if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, "That file is empty.");
    const name = cleanName(typeof req.query.name === "string" ? req.query.name : "file");
    const used = await one<{ n: string }>(
      `select coalesce(sum(a.size), 0)::text as n from attachments a join channels c on c.id = a.channel_id where c.server_id = $1`,
      [serverId]
    );
    if (Number(used!.n) + data.length > SERVER_QUOTA_BYTES)
      throw new HttpError(413, "This server has used up its file storage.");
    const attachment = await one<AttachmentDto>(
      `insert into attachments(channel_id, uploader_id, name, mime, size, data) values ($1, $2, $3, $4, $5, $6) returning id, name, mime, size`,
      [req.params.channelId, user.id, name, sniffImage(data) ?? "application/octet-stream", data.length, data]
    );
    res.json({ attachment });
  })
);

api.get("/files/:fileId", h(async (req, res) => {
  const f = await one<any>(
    `select a.name, a.mime, a.size, a.data, c.server_id from attachments a join channels c on c.id = a.channel_id
      where a.id = $1 and a.message_id is not null`,
    [req.params.fileId]
  );
  if (!f) throw new HttpError(404, "File not found.");
  await requireMember(f.server_id, req.user!.id);
  const inline = f.mime.startsWith("image/");
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Length", String(f.size));
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  // Uploaded content never runs as a page, whatever it claims to be.
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
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
  if (await timeoutUntil(m.server_id, userId)) throw new HttpError(403, "You're timed out in this server.");
  return m;
}
const reactionParams = (p: Record<string, string>) => ({
  messageId: z.string().regex(/^\d+$/, "Message not found.").parse(p.messageId),
  emoji: z.string().regex(EMOJI_RE, "That isn't an emoji.").parse(p.emoji),
});

api.put("/messages/:messageId/reactions/:emoji", h(async (req, res) => {
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

api.delete("/messages/:messageId/reactions/:emoji", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`react:${user.id}`, 30, 10_000);
  const { messageId, emoji } = reactionParams(req.params);
  const m = await reactionContext(messageId, user.id);
  const removed = await q(`delete from reactions where message_id = $1::bigint and user_id = $2 and emoji = $3 returning 1`, [messageId, user.id, emoji]);
  if (removed.length) emitServer(m.server_id, "reaction.update", { serverId: m.server_id, channelId: m.channel_id, messageId, emoji, userId: user.id, added: false });
  res.json({ ok: true });
}));
