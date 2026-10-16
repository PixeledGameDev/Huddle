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
