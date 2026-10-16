import crypto from "crypto";
import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { adminRouter } from "./admin";
import { gifsRouter } from "./gifs";
import { messagesRouter } from "./messages";
import { assertNotTimedOut, membership, requireAdmin, requireMember, timeoutUntil, type Role } from "./perms";
import { pollsRouter } from "./polls";
import { profilesRouter } from "./profiles";
import { emitServer, isOnline, joinServerRooms, leaveServerRooms } from "./realtime";
import { listOpenVotes, voteRouter } from "./votes";

export const api = Router();
api.use(voteRouter, messagesRouter, pollsRouter, profilesRouter, adminRouter, gifsRouter);

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
      `select u.id, u.username, u.display_name, u.avatar_version, u.accent, u.status_text, m.role, t.until as timeout_until
         from memberships m join users u on u.id = m.user_id
         left join server_timeouts t on t.server_id = m.server_id and t.user_id = m.user_id and t.until > now()
        where m.server_id = $1`,
      [serverId]
    )
  )
    .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name ?? null, avatarVersion: r.avatar_version as number, accent: r.accent ?? null, statusText: r.status_text as string, role: r.role as Role, online: isOnline(r.id), timeoutUntil: r.timeout_until ? new Date(r.timeout_until).toISOString() : null }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  const settings = Object.fromEntries(Object.entries(settingsColumns).map(([k, col]) => [k, s[col]]));
  return {
    id: s.id,
    name: s.name,
    iconVersion: s.icon_version as number,
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
    servers: await q(`select s.id, s.name, s.icon_version as "iconVersion" from servers s join memberships m on m.server_id = s.id where m.user_id = $1 order by s.created_at`, [req.user!.id]),
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
  res.json({ server: await one(`select id, name, icon_version as "iconVersion" from servers where id = $1`, [inv.server_id]) });
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
