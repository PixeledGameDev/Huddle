import type { Member, Permission, ServerDetail, ServerRole } from "./types";

export const PERMISSION_INFO: { key: Permission; label: string; help: string }[] = [
  { key: "manage_server", label: "Manage server", help: "Change server settings, the icon and vote moderation." },
  { key: "manage_channels", label: "Manage channels", help: "Create, rename and delete channels." },
  { key: "manage_roles", label: "Manage roles", help: "Create and edit roles below their own, and give them to people." },
  { key: "manage_messages", label: "Manage messages", help: "Delete other people's messages, close polls and see deleted messages." },
  { key: "kick_members", label: "Kick members", help: "Remove people from the server (they can rejoin)." },
  { key: "ban_members", label: "Ban members", help: "Ban and unban people." },
  { key: "timeout_members", label: "Time out members", help: "Stop people from chatting for a while." },
  { key: "mention_everyone", label: "Mention @everyone", help: "Notify every member at once." },
  { key: "view_audit_log", label: "View activity log", help: "See the server's moderation and settings history." },
];

export const can = (server: ServerDetail | null | undefined, perm: Permission) => !!server && server.myPermissions.includes(perm);
export const canAny = (server: ServerDetail | null | undefined, perms: Permission[]) => perms.some((p) => can(server, p));
export const isOwner = (server: ServerDetail | null | undefined) => server?.myRole === "owner";

/** Whether the viewer may moderate (kick, ban or time out) this member. */
export function canModerateMember(server: ServerDetail, meId: string, m: Member) {
  return m.id !== meId && m.role !== "owner" && server.myTop > m.top && canAny(server, ["kick_members", "ban_members", "timeout_members"]);
}

/** A role the viewer is allowed to hand out or edit (owners can touch every role). */
export const canEditRole = (server: ServerDetail, role: ServerRole) => can(server, "manage_roles") && server.myTop > role.position;

/** The color of a member's highest role that has one. */
export function memberColor(server: ServerDetail, m: Member): string | null {
  for (const id of m.roleIds) {
    const r = server.roles.find((x) => x.id === id);
    if (r?.color) return r.color;
  }
  return null;
}
