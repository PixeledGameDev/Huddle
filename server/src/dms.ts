import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { areFriends, dropFriendship } from "./friends";
import { getMessageDto } from "./hydrate";
import { assertCanWrite } from "./perms";
import { emitServer, emitUser, isOnline, joinServerRooms, statusOf } from "./realtime";

export const dmsRouter = Router();

const userDto = (r: any) => ({
  id: r.user_id as string,
  username: r.username as string,
  displayName: (r.display_name ?? null) as string | null,
  avatarVersion: r.avatar_version as number,
  accent: (r.accent ?? null) as string | null,
  statusText: r.status_text as string,
  nameFont: (r.name_font ?? "default") as string,
});

/** The other person in each of viewerId's DMs (or just one DM), newest conversation first. */
export async function dmList(viewerId: string, serverId?: string) {
  const rows = await q<any>(
    `select s.id as server_id, u.id as user_id, u.username, u.display_name, u.avatar_version, u.accent, u.status_text, u.name_font,
            coalesce((select max(m.created_at) from messages m join channels c on c.id = m.channel_id where c.server_id = s.id), s.created_at) as last_at,
            exists(select 1 from user_blocks b where b.blocker = $1 and b.blocked = u.id) as blocked_by_me
       from servers s
       join memberships me on me.server_id = s.id and me.user_id = $1
       join memberships o on o.server_id = s.id and o.user_id <> $1
       join users u on u.id = o.user_id
      where s.is_dm and ($2::uuid is null or s.id = $2::uuid) and ($2::uuid is not null or me.dm_hidden_at is null)
      order by last_at desc`,
    [viewerId, serverId ?? null]
  );
  return rows.map((r) => ({
    id: r.server_id as string,
    lastAt: new Date(r.last_at).toISOString(),
    online: isOnline(r.user_id),
    status: statusOf(r.user_id),
    blockedByMe: r.blocked_by_me as boolean,
    user: userDto(r),
  }));
}

dmsRouter.get("/dms", h(async (req, res) => {
  res.json({ dms: await dmList(req.user!.id) });
}));

export type DmPrivacy = "everyone" | "friends" | "nobody";

/** Starting a new conversation obeys the other person's privacy setting. Conversations that already exist are unaffected. */
export async function assertAllowsNewDm(me: string, userId: string) {
  const t = await one<{ dm_privacy: DmPrivacy }>(`select dm_privacy from users where id = $1`, [userId]);
  if (!t || t.dm_privacy === "everyone") return;
  if (t.dm_privacy === "friends" && (await areFriends(me, userId))) return;
  throw new HttpError(403, t.dm_privacy === "friends" ? "This person only accepts new direct messages from friends." : "This person isn't accepting new direct messages.");
}

/** Opens (or creates) the DM between two people. Only people who share a server can start one, and blocked pairs can't. */
export async function openDm(me: string, userId: string) {
  if (userId === me) throw new HttpError(400, "You can't message yourself.");
  if (!(await one(`select 1 from users where id = $1 and deleted_at is null`, [userId]))) throw new HttpError(404, "User not found.");
  if (await one(`select 1 from user_blocks where (blocker = $1 and blocked = $2) or (blocker = $2 and blocked = $1)`, [me, userId]))
    throw new HttpError(403, "You can't message this person.");

  const key = [me, userId].sort().join(":");
  let serverId = (await one<{ id: string }>(`select id from servers where dm_key = $1`, [key]))?.id;
  let created = false;
  if (!serverId) {
    if (await one(`select 1 from users where id = $1 and is_bot`, [userId])) throw new HttpError(403, "Huddle is a bot, so it can't read replies.");
    rateLimit(`newdm:${me}`, 20, 3600_000);
    const shared = await one(
      `select 1 from memberships a join memberships b on a.server_id = b.server_id join servers s on s.id = a.server_id
        where a.user_id = $1 and b.user_id = $2 and not s.is_dm limit 1`,
      [me, userId]
    );
    if (!shared) throw new HttpError(403, "You can only message people you share a server with.");
    await assertAllowsNewDm(me, userId);
    serverId = await tx(async (c) => {
      const s = await one<{ id: string }>(
        `insert into servers(name, owner_id, is_dm, dm_key) values ('', $1, true, $2) on conflict (dm_key) where dm_key is not null do nothing returning id`,
        [me, key],
        c
      );
      if (!s) return (await one<{ id: string }>(`select id from servers where dm_key = $1`, [key], c))!.id;
      created = true;
      await q(`insert into memberships(server_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')`, [s.id, me, userId], c);
      await q(`insert into channels(server_id, name) values ($1, 'chat')`, [s.id], c);
      return s.id;
    });
    joinServerRooms(me, serverId);
    joinServerRooms(userId, serverId);
  }
  // Opening a conversation you had removed puts it back in your list.
  await q(`update memberships set dm_hidden_at = null where server_id = $1 and user_id = $2 and dm_hidden_at is not null`, [serverId, me]);
  if (created) emitUser(userId, "dm.new", (await dmList(userId, serverId))[0]);
  return { serverId, dm: (await dmList(me, serverId))[0] };
}

/** Call right before a message is sent into a DM: anyone who had removed it from their list gets it back. */
export async function revealDm(serverId: string) {
  const rows = await q<{ user_id: string }>(
    `update memberships m set dm_hidden_at = null
       from servers s
      where m.server_id = $1 and s.id = m.server_id and s.is_dm and m.dm_hidden_at is not null
      returning m.user_id`,
    [serverId]
  );
  for (const r of rows) {
    const dm = (await dmList(r.user_id, serverId))[0];
    if (dm) emitUser(r.user_id, "dm.new", dm);
  }
}

/** Removes a conversation from your own list. Nothing is deleted, and the other person isn't told. */
dmsRouter.delete("/dms/:serverId", h(async (req, res) => {
  const me = req.user!.id;
  const { serverId } = z.object({ serverId: z.string().uuid() }).parse(req.params);
  const rows = await q(
    `update memberships m set dm_hidden_at = now()
       from servers s
      where m.server_id = $1 and m.user_id = $2 and s.id = m.server_id and s.is_dm
      returning m.user_id`,
    [serverId, me]
  );
  if (!rows.length) throw new HttpError(404, "Conversation not found.");
  emitUser(me, "dm.hidden", { id: serverId }); // keeps your other open windows in step
  res.json({ ok: true });
}));

dmsRouter.post("/dms", h(async (req, res) => {
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  const { dm } = await openDm(req.user!.id, userId);
  res.json({ dm });
}));

/** Replies to what someone has set as their status: opens the DM if needed and sends a message that quotes the status. */
dmsRouter.post("/users/:userId/status-reply", h(async (req, res) => {
  const me = req.user!.id;
  const { userId } = req.params;
  rateLimit(`msg:${me}`, 6, 5000);
  const { content } = z.object({ content: z.string().trim().min(1, "Write a reply.").max(2000) }).parse(req.body);
  const target = await one<{ status_text: string }>(`select status_text from users where id = $1 and deleted_at is null`, [userId]);
  if (!target) throw new HttpError(404, "User not found.");
  if (!target.status_text) throw new HttpError(409, "They don't have a status to reply to any more.");
  const { serverId, dm } = await openDm(me, userId);
  await assertCanWrite(serverId, me);
  await revealDm(serverId);
  const ch = await one<{ id: string }>(`select id from channels where server_id = $1 limit 1`, [serverId]);
  const row = await one<{ id: string }>(
    `insert into messages(channel_id, author_id, content, status_reply) values ($1, $2, $3, $4) returning id::text as id`,
    [ch!.id, me, content, target.status_text]
  );
  const message = await getMessageDto(row!.id, null);
  emitServer(serverId, "message.create", message);
  res.json({ dm, message });
}));

// ---------- blocking ----------
dmsRouter.get("/blocks", h(async (req, res) => {
  const rows = await q<any>(
    `select u.id as user_id, u.username, u.display_name, u.avatar_version, u.accent, u.status_text, u.name_font
       from user_blocks b join users u on u.id = b.blocked where b.blocker = $1 order by u.username`,
    [req.user!.id]
  );
  res.json({ users: rows.map(userDto) });
}));

dmsRouter.put("/users/:userId/block", h(async (req, res) => {
  const me = req.user!.id;
  if (req.params.userId === me) throw new HttpError(400, "You can't block yourself.");
  if (!(await one(`select 1 from users where id = $1`, [req.params.userId]))) throw new HttpError(404, "User not found.");
  await q(`insert into user_blocks(blocker, blocked) values ($1, $2) on conflict do nothing`, [me, req.params.userId]);
  await dropFriendship(me, req.params.userId);
  res.json({ ok: true });
}));

dmsRouter.delete("/users/:userId/block", h(async (req, res) => {
  await q(`delete from user_blocks where blocker = $1 and blocked = $2`, [req.user!.id, req.params.userId]);
  res.json({ ok: true });
}));
