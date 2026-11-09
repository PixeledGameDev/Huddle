import { q } from "./db";
import { HttpError } from "./http";
import type { Access } from "./perms";

/**
 * Channel permissions. Every channel starts open to every member. A Huddle channel can then carry overrides, one per role
 * (or one for "everyone"), that explicitly allow or deny these four things in that channel only.
 *
 * Working out what someone can do in a channel: start with everything allowed, apply the "everyone" override, then apply the
 * overrides of the roles they hold (denies first, then allows, so a role that allows something beats another role's deny).
 * Without "view_channel" they can do nothing there. Owners, admins, Huddle Admins and anyone who can manage channels ignore
 * overrides entirely, since they could change them anyway.
 */
export const CHANNEL_PERMS = ["view_channel", "send_messages", "add_reactions", "attach_files"] as const;
export type ChannelPerm = (typeof CHANNEL_PERMS)[number];
export const isChannelPerm = (p: string): p is ChannelPerm => (CHANNEL_PERMS as readonly string[]).includes(p);

export interface Override { roleId: string | null; allow: ChannelPerm[]; deny: ChannelPerm[] }
const toOverride = (r: any): Override => ({ roleId: (r.role_id ?? null) as string | null, allow: (r.allow as string[]).filter(isChannelPerm), deny: (r.deny as string[]).filter(isChannelPerm) });

const everything = () => new Set<ChannelPerm>(CHANNEL_PERMS);

export const bypassesOverrides = (me: Pick<Access, "role" | "perms">) => me.role !== "member" || me.perms.has("manage_channels");

export function resolveChannelPerms(overrides: Override[], roleIds: string[]): Set<ChannelPerm> {
  const granted = everything();
  const everyone = overrides.find((o) => o.roleId === null);
  if (everyone) {
    for (const p of everyone.deny) granted.delete(p);
    for (const p of everyone.allow) granted.add(p);
  }
  const mine = overrides.filter((o) => o.roleId !== null && roleIds.includes(o.roleId));
  for (const p of mine.flatMap((o) => o.deny)) granted.delete(p);
  for (const p of mine.flatMap((o) => o.allow)) granted.add(p);
  return granted.has("view_channel") ? granted : new Set();
}

/** What this member can do in this channel. One cheap query when the channel has no overrides, which is nearly always. */
export async function channelPerms(channelId: string, serverId: string, userId: string, me: Access): Promise<Set<ChannelPerm>> {
  const rows = await q(`select role_id, allow, deny from channel_overrides where channel_id = $1`, [channelId]);
  if (!rows.length || bypassesOverrides(me)) return everything();
  const roleIds = (await q<{ role_id: string }>(`select role_id from member_roles where server_id = $1 and user_id = $2`, [serverId, userId])).map((r) => r.role_id);
  return resolveChannelPerms(rows.map(toOverride), roleIds);
}

const DENIED: Record<ChannelPerm, string> = {
  view_channel: "You don't have access to this channel.",
  send_messages: "You don't have permission to send messages in this channel.",
  add_reactions: "You don't have permission to add reactions in this channel.",
  attach_files: "You don't have permission to attach files in this channel.",
};

/** Throws unless the member may see the channel and has every permission listed. */
export async function requireChannelPerms(channelId: string, serverId: string, userId: string, me: Access, ...needed: ChannelPerm[]) {
  const perms = await channelPerms(channelId, serverId, userId, me);
  for (const p of ["view_channel" as ChannelPerm, ...needed]) if (!perms.has(p)) throw new HttpError(403, DENIED[p]);
}

export interface ChannelView { id: string; name: string; perms: ChannelPerm[]; restricted: boolean }

/** The channels of a server as one member sees them: the ones they can't view are left out, and each carries what they can do there. */
export async function channelsFor(serverId: string, me: Access, roleIds: string[]): Promise<ChannelView[]> {
  const [channels, rows] = await Promise.all([
    q<{ id: string; name: string }>(`select id, name from channels where server_id = $1 order by created_at`, [serverId]),
    q<any>(`select channel_id, role_id, allow, deny from channel_overrides where channel_id in (select id from channels where server_id = $1)`, [serverId]),
  ]);
  const bypass = bypassesOverrides(me);
  const out: ChannelView[] = [];
  for (const c of channels) {
    const mine = rows.filter((r) => r.channel_id === c.id).map(toOverride);
    const perms = !mine.length || bypass ? everything() : resolveChannelPerms(mine, roleIds);
    if (!perms.has("view_channel")) continue;
    out.push({ id: c.id, name: c.name, perms: [...perms], restricted: mine.length > 0 });
  }
  return out;
}

/** Members who must not hear about this channel's activity live (its messages, reactions, typing). Empty unless view access is restricted. */
export async function hiddenFrom(serverId: string, channelId: string): Promise<string[]> {
  const rows = await q(`select role_id, allow, deny from channel_overrides where channel_id = $1`, [channelId]);
  const overrides = rows.map(toOverride);
  if (!overrides.some((o) => o.allow.includes("view_channel") || o.deny.includes("view_channel"))) return [];
  const members = await q<any>(
    `select m.user_id as id, m.role, u.huddle_admin,
            coalesce((select array_agg(mr.role_id) from member_roles mr where mr.server_id = m.server_id and mr.user_id = m.user_id), '{}') as role_ids,
            exists (select 1 from member_roles mr join server_roles r on r.id = mr.role_id
                     where mr.server_id = m.server_id and mr.user_id = m.user_id and 'manage_channels' = any(r.permissions)) as manager
       from memberships m join users u on u.id = m.user_id where m.server_id = $1`,
    [serverId]
  );
  return members
    .filter((m) => m.role === "member" && !m.huddle_admin && !m.manager && !resolveChannelPerms(overrides, m.role_ids).has("view_channel"))
    .map((m) => m.id as string);
}
