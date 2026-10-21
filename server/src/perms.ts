import { one } from "./db";
import { HttpError } from "./http";

export type Role = "owner" | "admin" | "member";

/**
 * Huddle Admins count as admins of every server (not DMs), whether or not they have joined it, and nothing in a
 * server's own member list or role badges marks them as different. Real owners stay owners.
 */
export async function membership(serverId: string, userId: string) {
  const r = await one<{ role: Role | null; joined_at: Date | null; huddle_admin: boolean; plain_server: boolean }>(
    `select m.role, m.joined_at, u.huddle_admin, (s.id is not null and not s.is_dm) as plain_server
       from users u
       left join memberships m on m.server_id = $1 and m.user_id = u.id
       left join servers s on s.id = $1
      where u.id = $2`,
    [serverId, userId]
  );
  if (!r) return null;
  const override = r.huddle_admin && r.plain_server;
  if (r.role) return { role: override && r.role === "member" ? ("admin" as Role) : r.role, joined_at: r.joined_at! };
  if (override) return { role: "admin" as Role, joined_at: new Date(0) };
  return null;
}
export async function isHuddleAdmin(userId: string) {
  return !!(await one(`select 1 from users where id = $1 and huddle_admin`, [userId]));
}
export async function requireMember(serverId: string, userId: string) {
  const m = await membership(serverId, userId);
  if (!m) throw new HttpError(403, "You're not in this server.");
  return m;
}
export async function requireAdmin(serverId: string, userId: string) {
  const m = await requireMember(serverId, userId);
  if (m.role === "member") throw new HttpError(403, "Only owners and admins can do that.");
  return m;
}
export async function timeoutUntil(serverId: string, userId: string) {
  const t = await one<{ until: Date }>(
    `select t.until from server_timeouts t join users u on u.id = t.user_id
      where t.server_id = $1 and t.user_id = $2 and t.until > now() and not u.huddle_admin`,
    [serverId, userId]
  );
  return t ? t.until.toISOString() : null;
}
export async function assertNotTimedOut(serverId: string, userId: string) {
  const until = await timeoutUntil(serverId, userId);
  if (until) throw new HttpError(403, "You're timed out in this server.", { timeoutUntil: until });
}
export async function channelServer(channelId: string) {
  const ch = await one<{ server_id: string }>(`select server_id from channels where id = $1`, [channelId]);
  if (!ch) throw new HttpError(404, "Channel not found.");
  return ch.server_id;
}

/** Timed-out members, and either side of a blocked DM, can't send, upload, react, or vote. */
export async function assertCanWrite(serverId: string, userId: string) {
  await assertNotTimedOut(serverId, userId);
  const blocked = await one(
    `select 1 from servers s
       join memberships o on o.server_id = s.id and o.user_id <> $2
       join user_blocks b on (b.blocker = o.user_id and b.blocked = $2) or (b.blocker = $2 and b.blocked = o.user_id)
      where s.id = $1 and s.is_dm limit 1`,
    [serverId, userId]
  );
  if (blocked) throw new HttpError(403, "You can't message this person.");
  const other = await one<{ deleted: boolean }>(
    `select (u.deleted_at is not null) as deleted from servers s
       join memberships o on o.server_id = s.id and o.user_id <> $2
       join users u on u.id = o.user_id and (u.is_bot or u.deleted_at is not null)
      where s.id = $1 and s.is_dm limit 1`,
    [serverId, userId]
  );
  if (other) throw new HttpError(403, other.deleted ? "This account has been deleted." : "Huddle is a bot, so it can't read replies.");
}

export async function assertNotDm(serverId: string) {
  const s = await one<{ is_dm: boolean }>(`select is_dm from servers where id = $1`, [serverId]);
  if (s?.is_dm) throw new HttpError(400, "That isn't available in direct messages.");
}
