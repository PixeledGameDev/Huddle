import { Router } from "express";
import { userFromCookie } from "./auth";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { isOnline } from "./realtime";
import { sendImage } from "./profiles";

/**
 * Invite links: https://your-app/invite/<code>. The info below is public to anyone who holds the code
 * (that's what lets the link show a server card before the visitor has signed in), and nothing else is exposed.
 */
export const invitesRouter = Router();

const CODE = /^[A-Za-z0-9_-]{6,32}$/;

export async function inviteMeta(code: string) {
  if (!CODE.test(code)) return null;
  const s = await one<any>(
    `select s.id, s.name, s.icon_version, s.verified, (select count(*)::int from memberships m where m.server_id = s.id) as member_count
       from invites i join servers s on s.id = i.server_id where i.code = $1 and not s.is_dm`,
    [code]
  );
  return s ? { id: s.id as string, name: s.name as string, iconVersion: s.icon_version as number, verified: s.verified as boolean, memberCount: s.member_count as number } : null;
}

invitesRouter.get("/invites/:code", h(async (req, res) => {
  rateLimit(`invinfo:${req.ip}`, 120, 60_000);
  const meta = await inviteMeta(req.params.code);
  if (!meta) throw new HttpError(404, "This invite is invalid.");
  const members = await q<{ user_id: string }>(`select user_id from memberships where server_id = $1`, [meta.id]);
  const user = await userFromCookie(req.headers.cookie);
  const joined = !!user && members.some((m) => m.user_id === user.id);
  res.json({
    name: meta.name,
    iconVersion: meta.iconVersion,
    verified: meta.verified,
    memberCount: meta.memberCount,
    onlineCount: members.filter((m) => isOnline(m.user_id)).length,
    joined,
    ...(joined ? { serverId: meta.id } : {}), // the id is only revealed to people already inside
  });
}));

invitesRouter.get("/invites/:code/icon", h(async (req, res) => {
  rateLimit(`invinfo:${req.ip}`, 120, 60_000);
  if (!CODE.test(req.params.code)) throw new HttpError(404, "No image.");
  sendImage(res, await one(`select si.mime, si.data from invites i join server_icons si on si.server_id = i.server_id where i.code = $1`, [req.params.code]));
}));
