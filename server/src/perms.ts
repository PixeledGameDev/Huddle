import { one } from "./db";
import { HttpError } from "./http";

export type Role = "owner" | "admin" | "member";

export async function membership(serverId: string, userId: string) {
  return one<{ role: Role; joined_at: Date }>(`select role, joined_at from memberships where server_id = $1 and user_id = $2`, [serverId, userId]);
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
  const t = await one<{ until: Date }>(`select until from server_timeouts where server_id = $1 and user_id = $2 and until > now()`, [serverId, userId]);
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
}

export async function assertNotDm(serverId: string) {
  const s = await one<{ is_dm: boolean }>(`select is_dm from servers where id = $1`, [serverId]);
  if (s?.is_dm) throw new HttpError(400, "That isn't available in direct messages.");
}
