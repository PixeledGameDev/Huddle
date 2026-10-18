import express, { Router, type Response } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { sniffImage } from "./fileutil";
import { HttpError, h, rateLimit } from "./http";
import { requireAdmin } from "./perms";
import { emitServer } from "./realtime";

export const profilesRouter = Router();

export async function getProfile(userId: string) {
  const r = await one<any>(`select id, username, display_name, bio, accent, status_text, avatar_version, created_at from users where id = $1`, [userId]);
  if (!r) return null;
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: (r.display_name ?? null) as string | null,
    bio: r.bio as string,
    accent: (r.accent ?? null) as string | null,
    statusText: r.status_text as string,
    avatarVersion: r.avatar_version as number,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

async function announceProfile(userId: string) {
  const rows = await q<{ server_id: string }>(`select server_id from memberships where user_id = $1`, [userId]);
  for (const r of rows) emitServer(r.server_id, "profile.update", { serverId: r.server_id, userId });
}

profilesRouter.get("/users/:userId/profile", h(async (req, res) => {
  const me = req.user!.id;
  const { userId } = req.params;
  if (userId !== me) {
    const shared = await one(`select 1 from memberships a join memberships b on a.server_id = b.server_id where a.user_id = $1 and b.user_id = $2 limit 1`, [me, userId]);
    if (!shared) throw new HttpError(403, "You don't share a server with this person.");
  }
  const profile = await getProfile(userId);
  if (!profile) throw new HttpError(404, "User not found.");
  let server: { role: string; joinedAt: string } | null = null;
  if (typeof req.query.serverId === "string") {
    const m = await one<any>(
      `select b.role, b.joined_at from memberships a join memberships b on a.server_id = b.server_id
        where a.server_id = $1 and a.user_id = $2 and b.user_id = $3`,
      [req.query.serverId, me, userId]
    );
    if (m) server = { role: m.role, joinedAt: new Date(m.joined_at).toISOString() };
  }
  const blockedByMe = !!(await one(`select 1 from user_blocks where blocker = $1 and blocked = $2`, [me, userId]));
  res.json({ profile, server, blockedByMe });
}));

const profileSchema = z
  .object({
    displayName: z.string().trim().max(32).nullable().transform((v) => (v ? v : null)),
    bio: z.string().trim().max(190),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a valid color.").nullable(),
    statusText: z.string().trim().max(80),
  })
  .partial();

profilesRouter.patch("/me/profile", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`profile:${user.id}`, 20, 60_000);
  const patch = profileSchema.parse(req.body);
  const columns: Record<string, string> = { displayName: "display_name", bio: "bio", accent: "accent", statusText: "status_text" };
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new HttpError(400, "Nothing to update.");
  const sets = entries.map(([k], i) => `${columns[k]} = $${i + 2}`).join(", ");
  await q(`update users set ${sets} where id = $1`, [user.id, ...entries.map(([, v]) => v)]);
  await announceProfile(user.id);
  res.json({ user: await getProfile(user.id) });
}));

// ---------- images: avatars and server icons ----------
const IMAGE_LIMIT = 1024 * 1024;
const imageBody = express.raw({ type: "application/octet-stream", limit: IMAGE_LIMIT });

function readImage(body: unknown) {
  if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, "That image is empty.");
  const mime = sniffImage(body);
  if (!mime) throw new HttpError(400, "Use a PNG, JPEG, GIF, or WebP image.");
  return { mime, data: body };
}
export function sendImage(res: Response, img: { mime: string; data: Buffer } | null) {
  if (!img) throw new HttpError(404, "No image.");
  res.setHeader("Content-Type", img.mime);
  res.setHeader("Content-Length", String(img.data.length));
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable"); // URLs carry ?v=<version>
  res.end(img.data);
}

profilesRouter.put("/me/avatar", imageBody, h(async (req, res) => {
  const user = req.user!;
  rateLimit(`avatar:${user.id}`, 10, 60_000);
  const { mime, data } = readImage(req.body);
  await tx(async (c) => {
    await q(`insert into user_avatars(user_id, mime, data) values ($1, $2, $3) on conflict (user_id) do update set mime = excluded.mime, data = excluded.data`, [user.id, mime, data], c);
    await q(`update users set avatar_version = avatar_version + 1 where id = $1`, [user.id], c);
  });
  await announceProfile(user.id);
  res.json({ user: await getProfile(user.id) });
}));

profilesRouter.delete("/me/avatar", h(async (req, res) => {
  const user = req.user!;
  await tx(async (c) => {
    await q(`delete from user_avatars where user_id = $1`, [user.id], c);
    await q(`update users set avatar_version = 0 where id = $1`, [user.id], c);
  });
  await announceProfile(user.id);
  res.json({ user: await getProfile(user.id) });
}));

profilesRouter.get("/users/:userId/avatar", h(async (req, res) => {
  sendImage(res, await one(`select mime, data from user_avatars where user_id = $1`, [req.params.userId]));
}));

profilesRouter.put("/servers/:serverId/icon", imageBody, h(async (req, res) => {
  const { serverId } = req.params;
  await requireAdmin(serverId, req.user!.id);
  rateLimit(`icon:${req.user!.id}`, 10, 60_000);
  const { mime, data } = readImage(req.body);
  await tx(async (c) => {
    await q(`insert into server_icons(server_id, mime, data) values ($1, $2, $3) on conflict (server_id) do update set mime = excluded.mime, data = excluded.data`, [serverId, mime, data], c);
    await q(`update servers set icon_version = icon_version + 1 where id = $1`, [serverId], c);
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

profilesRouter.delete("/servers/:serverId/icon", h(async (req, res) => {
  const { serverId } = req.params;
  await requireAdmin(serverId, req.user!.id);
  await tx(async (c) => {
    await q(`delete from server_icons where server_id = $1`, [serverId], c);
    await q(`update servers set icon_version = 0 where id = $1`, [serverId], c);
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

profilesRouter.get("/servers/:serverId/icon", h(async (req, res) => {
  const member = await one(`select 1 from memberships where server_id = $1 and user_id = $2`, [req.params.serverId, req.user!.id]);
  if (!member) throw new HttpError(403, "You're not in this server.");
  sendImage(res, await one(`select mime, data from server_icons where server_id = $1`, [req.params.serverId]));
}));
