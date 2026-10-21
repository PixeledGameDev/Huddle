import { one } from "./db";
import { HttpError } from "./http";

export type Role = "owner" | "admin" | "member";

/** Every permission a server role can grant. The owner always has all of them. */
export const PERMISSIONS = [
  "manage_server",
  "manage_channels",
  "manage_roles",
  "manage_messages",
  "kick_members",
  "ban_members",
  "timeout_members",
  "mention_everyone",
  "view_audit_log",
] as const;
export type Permission = (typeof PERMISSIONS)[number];
const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);
/** Anyone holding one of these counts as staff: they can't be voted on. */
export const STAFF_PERMISSIONS: Permission[] = PERMISSIONS.filter((p) => p !== "mention_everyone" && p !== "view_audit_log");

/** Rank used to decide who can act on whom. Higher outranks lower; role positions sit far below both. */
export const OWNER_TOP = 1_000_000_000;
export const ADMIN_TOP = 1_000_000;

export interface Access {
  role: Role;
  joined_at: Date;
  perms: Set<Permission>;
  top: number;
}

/**
 * Huddle Admins count as admins of every server (not DMs), whether or not they have joined it, and nothing in a
 * server's own member list or role badges marks them as different. Real owners stay owners.
 * The legacy "admin" membership role (from before roles existed) keeps every permission except manage_roles until the owner converts it.
 */
export async function membership(serverId: string, userId: string): Promise<Access | null> {
  const r = await one<{ role: Role | null; joined_at: Date | null; huddle_admin: boolean; plain_server: boolean; perms: string[]; top: number }>(
    `select m.role, m.joined_at, u.huddle_admin, (s.id is not null and not s.is_dm) as plain_server,
            coalesce((select array_agg(distinct p) from member_roles mr join server_roles r on r.id = mr.role_id
                        cross join lateral unnest(r.permissions) as p where mr.server_id = $1 and mr.user_id = u.id), '{}') as perms,
            coalesce((select max(r.position) from member_roles mr join server_roles r on r.id = mr.role_id
                       where mr.server_id = $1 and mr.user_id = u.id), 0) as top
       from users u
       left join memberships m on m.server_id = $1 and m.user_id = u.id
       left join servers s on s.id = $1
      where u.id = $2`,
    [serverId, userId]
  );
  if (!r) return null;
  const override = r.huddle_admin && r.plain_server;
  let role: Role;
  let joined: Date;
  if (r.role) {
    role = override && r.role === "member" ? "admin" : r.role;
    joined = r.joined_at!;
  } else if (override) {
    role = "admin";
    joined = new Date(0);
  } else return null;
  if (role === "owner") return { role, joined_at: joined, perms: new Set(PERMISSIONS), top: OWNER_TOP };
  if (role === "admin") return { role, joined_at: joined, perms: new Set(PERMISSIONS.filter((p) => p !== "manage_roles")), top: ADMIN_TOP };
  return { role, joined_at: joined, perms: new Set(r.perms.filter(isPermission)), top: Number(r.top) };
}
export async function isHuddleAdmin(userId: string) {
  return !!(await one(`select 1 from users where id = $1 and huddle_admin`, [userId]));
}
export async function requireMember(serverId: string, userId: string) {
  const m = await membership(serverId, userId);
  if (!m) throw new HttpError(403, "You're not in this server.");
  return m;
}
export async function requirePerm(serverId: string, userId: string, perm: Permission) {
  const m = await requireMember(serverId, userId);
  if (!m.perms.has(perm)) throw new HttpError(403, "You don't have permission to do that.");
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
