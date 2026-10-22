import express, { Router, type Response } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { sniffImage } from "./fileutil";
import { HttpError, h, rateLimit } from "./http";
import { assertAllowsNewDm } from "./dms";
import { areFriends, friendshipState } from "./friends";
import { requireMember, requirePerm } from "./perms";
import { emitServer, setPresence, statusOf } from "./realtime";

export const profilesRouter = Router();

/** Fonts people can pick for their display name. They ship with the app (the page can't load fonts from other sites). */
export const NAME_FONTS = ["default", "serif", "mono", "handwriting", "script", "display", "retro", "techno", "elegant", "impact"] as const;

export async function getProfile(userId: string) {
  const r = await one<any>(`select id, username, display_name, bio, accent, status_text, avatar_version, created_at, huddle_admin, presence, dm_privacy, banner_version, name_font from users where id = $1`, [userId]);
  if (!r) return null;
  return {
    id: r.id as string,
    username: r.username as string,
    displayName: (r.display_name ?? null) as string | null,
    bio: r.bio as string,
    accent: (r.accent ?? null) as string | null,
    statusText: r.status_text as string,
    avatarVersion: r.avatar_version as number,
    bannerVersion: r.banner_version as number,
    nameFont: r.name_font as string,
    createdAt: new Date(r.created_at).toISOString(),
    status: statusOf(userId) as string, // how others currently see them
    dmPrivacy: r.dm_privacy as string | null, // who may start a DM with them (hidden from everyone else by the profile route)
    presence: r.presence as string | null, // what they chose (hidden from everyone else by the profile route)
    huddleAdmin: r.huddle_admin as boolean, // only ever sent to the person themselves (see the profile route below)
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
  if (userId !== me) {
    profile.huddleAdmin = false; // nobody can see who else is a Huddle Admin
    profile.presence = null; // an invisible person must not be given away
    profile.dmPrivacy = null;
  }
  let server: { role: string; joinedAt: string; roles: { id: string; name: string; color: string | null }[] } | null = null;
  if (typeof req.query.serverId === "string") {
    const m = await one<any>(
      `select b.role, b.joined_at from memberships a join memberships b on a.server_id = b.server_id
        where a.server_id = $1 and a.user_id = $2 and b.user_id = $3`,
      [req.query.serverId, me, userId]
    );
    if (m) {
      const roles = await q<any>(
        `select r.id, r.name, r.color from member_roles mr join server_roles r on r.id = mr.role_id where mr.server_id = $1 and mr.user_id = $2 order by r.position desc`,
        [req.query.serverId, userId]
      );
      server = { role: m.role, joinedAt: new Date(m.joined_at).toISOString(), roles: roles.map((r) => ({ id: r.id, name: r.name, color: r.color ?? null })) };
    }
  }
  const blockedByMe = !!(await one(`select 1 from user_blocks where blocker = $1 and blocked = $2`, [me, userId]));
  let extra: object = {};
  if (userId !== me) {
    const blockedEither = !!(await one(`select 1 from user_blocks where (blocker = $1 and blocked = $2) or (blocker = $2 and blocked = $1)`, [me, userId]));
    const mutualServers = await q<any>(
      `select s.id, s.name, s.icon_version, s.verified from servers s
         join memberships a on a.server_id = s.id and a.user_id = $1 join memberships b on b.server_id = s.id and b.user_id = $2
        where not s.is_dm order by s.name limit 50`,
      [me, userId]
    );
    const mutualFriends = await q<any>(
      `select u.id, u.username, u.display_name, u.avatar_version, u.accent from users u
        where u.deleted_at is null and u.id <> $1 and u.id <> $2
          and exists (select 1 from friendships f where f.user_a = least(u.id, $1::uuid) and f.user_b = greatest(u.id, $1::uuid))
          and exists (select 1 from friendships f where f.user_a = least(u.id, $2::uuid) and f.user_b = greatest(u.id, $2::uuid))
        order by lower(u.username) limit 50`,
      [me, userId]
    );
    let canMessage = !blockedEither;
    if (canMessage && !(await one(`select 1 from servers where dm_key = $1`, [[me, userId].sort().join(":")]))) {
      canMessage = await assertAllowsNewDm(me, userId).then(() => true, () => false);
    }
    extra = {
      friendship: await friendshipState(me, userId),
      canMessage,
      mutualServers: mutualServers.map((s) => ({ id: s.id, name: s.name, iconVersion: s.icon_version, verified: s.verified as boolean })),
      mutualFriends: mutualFriends.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name ?? null, avatarVersion: u.avatar_version, accent: u.accent ?? null })),
    };
  }
  res.json({ profile, server, blockedByMe, ...extra });
}));

const profileSchema = z
  .object({
    displayName: z.string().trim().max(32).nullable().transform((v) => (v ? v : null)),
    bio: z.string().trim().max(190),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a valid color.").nullable(),
    statusText: z.string().trim().max(80),
    presence: z.enum(["online", "idle", "dnd", "invisible"]),
    dmPrivacy: z.enum(["everyone", "friends", "nobody"]),
    nameFont: z.enum(NAME_FONTS),
  })
  .partial();

profilesRouter.patch("/me/profile", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`profile:${user.id}`, 20, 60_000);
  const patch = profileSchema.parse(req.body);
  const columns: Record<string, string> = { displayName: "display_name", bio: "bio", accent: "accent", statusText: "status_text", presence: "presence", dmPrivacy: "dm_privacy", nameFont: "name_font" };
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (!entries.length) throw new HttpError(400, "Nothing to update.");
  const sets = entries.map(([k], i) => `${columns[k]} = $${i + 2}`).join(", ");
  await q(`update users set ${sets} where id = $1`, [user.id, ...entries.map(([, v]) => v)]);
  if (patch.presence) await setPresence(user.id, patch.presence);
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

// Banners are wider, so they get their own size limit.
const bannerBody = express.raw({ type: "application/octet-stream", limit: 2 * 1024 * 1024 });

profilesRouter.put("/me/banner", bannerBody, h(async (req, res) => {
  const user = req.user!;
  rateLimit(`banner:${user.id}`, 10, 60_000);
  const { mime, data } = readImage(req.body);
  await tx(async (c) => {
    await q(`insert into user_banners(user_id, mime, data) values ($1, $2, $3) on conflict (user_id) do update set mime = excluded.mime, data = excluded.data`, [user.id, mime, data], c);
    await q(`update users set banner_version = banner_version + 1 where id = $1`, [user.id], c);
  });
  await announceProfile(user.id);
  res.json({ user: await getProfile(user.id) });
}));

profilesRouter.delete("/me/banner", h(async (req, res) => {
  const user = req.user!;
  await tx(async (c) => {
    await q(`delete from user_banners where user_id = $1`, [user.id], c);
    await q(`update users set banner_version = 0 where id = $1`, [user.id], c);
  });
  await announceProfile(user.id);
  res.json({ user: await getProfile(user.id) });
}));

profilesRouter.get("/users/:userId/banner", h(async (req, res) => {
  sendImage(res, await one(`select mime, data from user_banners where user_id = $1`, [req.params.userId]));
}));

profilesRouter.put("/servers/:serverId/icon", imageBody, h(async (req, res) => {
  const { serverId } = req.params;
  await requirePerm(serverId, req.user!.id, "manage_server");
  rateLimit(`icon:${req.user!.id}`, 10, 60_000);
  const { mime, data } = readImage(req.body);
  await tx(async (c) => {
    await q(`insert into server_icons(server_id, mime, data) values ($1, $2, $3) on conflict (server_id) do update set mime = excluded.mime, data = excluded.data`, [serverId, mime, data], c);
    await q(`update servers set icon_version = icon_version + 1 where id = $1`, [serverId], c);
    await q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, 'server.icon', '{"removed":false}')`, [serverId, req.user!.id], c);
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

profilesRouter.delete("/servers/:serverId/icon", h(async (req, res) => {
  const { serverId } = req.params;
  await requirePerm(serverId, req.user!.id, "manage_server");
  await tx(async (c) => {
    await q(`delete from server_icons where server_id = $1`, [serverId], c);
    await q(`update servers set icon_version = 0 where id = $1`, [serverId], c);
    await q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, 'server.icon', '{"removed":true}')`, [serverId, req.user!.id], c);
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

profilesRouter.get("/servers/:serverId/icon", h(async (req, res) => {
  await requireMember(req.params.serverId, req.user!.id);
  sendImage(res, await one(`select mime, data from server_icons where server_id = $1`, [req.params.serverId]));
}));
