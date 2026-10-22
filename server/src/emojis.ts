import express, { Router } from "express";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { requirePerm } from "./perms";
import { readImage, sendImage } from "./profiles";
import { emitServer } from "./realtime";

export const emojisRouter = Router();

const MAX_EMOJIS = 50;
const MAX_STICKERS = 20;
const emojiBody = express.raw({ type: "application/octet-stream", limit: 256 * 1024 });
const stickerBody = express.raw({ type: "application/octet-stream", limit: 512 * 1024 });
const nameSchema = z.string().trim().regex(/^[A-Za-z0-9_]{2,32}$/, "Names use 2 to 32 letters, numbers or underscores.");

/** Custom emoji appear in message text as <:name:id>. */
export const CUSTOM_EMOJI_RE = /<:([A-Za-z0-9_]{2,32}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/g;

/** Emoji from another server (or deleted ones) can't be used here, so they turn back into plain :name: text. */
export async function cleanCustomEmoji(serverId: string, content: string) {
  const ids = [...new Set([...content.matchAll(CUSTOM_EMOJI_RE)].map((m) => m[2]))];
  if (!ids.length) return content;
  const ok = new Set((await q<{ id: string }>(`select id from server_emojis where server_id = $1 and id = any($2::uuid[])`, [serverId, ids])).map((r) => r.id));
  return content.replace(CUSTOM_EMOJI_RE, (all, name: string, id: string) => (ok.has(id) ? all : `:${name}:`));
}

const audit = (serverId: string, actor: string, action: string, detail: object) =>
  q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, $3, $4)`, [serverId, actor, action, JSON.stringify(detail)]);

function routesFor(kind: "emoji" | "sticker") {
  const table = kind === "emoji" ? "server_emojis" : "server_stickers";
  const plural = kind === "emoji" ? "emojis" : "stickers";
  const max = kind === "emoji" ? MAX_EMOJIS : MAX_STICKERS;

  emojisRouter.get(`/${plural}/:id`, h(async (req, res) => {
    if (!/^[0-9a-f-]{36}$/.test(req.params.id)) throw new HttpError(404, "No image.");
    sendImage(res, await one(`select mime, data from ${table} where id = $1`, [req.params.id]));
  }));

  emojisRouter.post(`/servers/:serverId/${plural}`, kind === "emoji" ? emojiBody : stickerBody, h(async (req, res) => {
    const { serverId } = req.params;
    const user = req.user!;
    await requirePerm(serverId, user.id, "manage_emojis");
    rateLimit(`${kind}:${user.id}`, 20, 60_000);
    const name = nameSchema.parse(req.query.name);
    const { mime, data } = readImage(req.body);
    const n = await one<{ n: number }>(`select count(*)::int as n from ${table} where server_id = $1`, [serverId]);
    if (n!.n >= max) throw new HttpError(400, `A server can have at most ${max} ${plural}.`);
    if (await one(`select 1 from ${table} where server_id = $1 and lower(name) = lower($2)`, [serverId, name])) throw new HttpError(409, "There is already one with that name.");
    const row = await one<{ id: string }>(`insert into ${table}(server_id, name, mime, data, created_by) values ($1, $2, $3, $4, $5) returning id`, [serverId, name, mime, data, user.id]);
    await audit(serverId, user.id, `${kind}.add`, { name });
    emitServer(serverId, "server.update", { serverId });
    res.json({ id: row!.id, name });
  }));

  emojisRouter.patch(`/servers/:serverId/${plural}/:id`, h(async (req, res) => {
    const { serverId, id } = req.params;
    const user = req.user!;
    await requirePerm(serverId, user.id, "manage_emojis");
    const name = nameSchema.parse(req.body?.name);
    const old = await one<{ name: string }>(`select name from ${table} where id = $1 and server_id = $2`, [id, serverId]);
    if (!old) throw new HttpError(404, "Not found.");
    if (await one(`select 1 from ${table} where server_id = $1 and lower(name) = lower($2) and id <> $3`, [serverId, name, id])) throw new HttpError(409, "There is already one with that name.");
    await q(`update ${table} set name = $3 where id = $1 and server_id = $2`, [id, serverId, name]);
    await audit(serverId, user.id, `${kind}.rename`, { from: old.name, to: name });
    emitServer(serverId, "server.update", { serverId });
    res.json({ ok: true });
  }));

  emojisRouter.delete(`/servers/:serverId/${plural}/:id`, h(async (req, res) => {
    const { serverId, id } = req.params;
    const user = req.user!;
    await requirePerm(serverId, user.id, "manage_emojis");
    const gone = await q<{ name: string }>(`delete from ${table} where id = $1 and server_id = $2 returning name`, [id, serverId]);
    if (!gone.length) throw new HttpError(404, "Not found.");
    await audit(serverId, user.id, `${kind}.delete`, { name: gone[0].name });
    emitServer(serverId, "server.update", { serverId });
    res.json({ ok: true });
  }));
}
routesFor("emoji");
routesFor("sticker");
