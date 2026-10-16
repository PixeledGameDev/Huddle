import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { emitUser, isOnline, joinServerRooms } from "./realtime";

export const dmsRouter = Router();

const userDto = (r: any) => ({
  id: r.user_id as string,
  username: r.username as string,
  displayName: (r.display_name ?? null) as string | null,
  avatarVersion: r.avatar_version as number,
  accent: (r.accent ?? null) as string | null,
  statusText: r.status_text as string,
});

/** The other person in each of viewerId's DMs (or just one DM), newest conversation first. */
async function dmList(viewerId: string, serverId?: string) {
  const rows = await q<any>(
    `select s.id as server_id, u.id as user_id, u.username, u.display_name, u.avatar_version, u.accent, u.status_text,
            coalesce((select max(m.created_at) from messages m join channels c on c.id = m.channel_id where c.server_id = s.id), s.created_at) as last_at,
            exists(select 1 from user_blocks b where b.blocker = $1 and b.blocked = u.id) as blocked_by_me
       from servers s
       join memberships me on me.server_id = s.id and me.user_id = $1
       join memberships o on o.server_id = s.id and o.user_id <> $1
       join users u on u.id = o.user_id
      where s.is_dm and ($2::uuid is null or s.id = $2::uuid)
      order by last_at desc`,
    [viewerId, serverId ?? null]
  );
  return rows.map((r) => ({
    id: r.server_id as string,
    lastAt: new Date(r.last_at).toISOString(),
    online: isOnline(r.user_id),
    blockedByMe: r.blocked_by_me as boolean,
    user: userDto(r),
  }));
}

dmsRouter.get("/dms", h(async (req, res) => {
  res.json({ dms: await dmList(req.user!.id) });
}));

/** Open (or create) a DM. Only people who share a server can start one, and blocked pairs can't. */
dmsRouter.post("/dms", h(async (req, res) => {
  const me = req.user!.id;
  const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
  if (userId === me) throw new HttpError(400, "You can't message yourself.");
  if (!(await one(`select 1 from users where id = $1`, [userId]))) throw new HttpError(404, "User not found.");
  if (await one(`select 1 from user_blocks where (blocker = $1 and blocked = $2) or (blocker = $2 and blocked = $1)`, [me, userId]))
    throw new HttpError(403, "You can't message this person.");

  const key = [me, userId].sort().join(":");
  let serverId = (await one<{ id: string }>(`select id from servers where dm_key = $1`, [key]))?.id;
  let created = false;
  if (!serverId) {
    rateLimit(`newdm:${me}`, 20, 3600_000);
    const shared = await one(
      `select 1 from memberships a join memberships b on a.server_id = b.server_id join servers s on s.id = a.server_id
        where a.user_id = $1 and b.user_id = $2 and not s.is_dm limit 1`,
      [me, userId]
    );
    if (!shared) throw new HttpError(403, "You can only message people you share a server with.");
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
  if (created) emitUser(userId, "dm.new", (await dmList(userId, serverId))[0]);
  res.json({ dm: (await dmList(me, serverId))[0] });
}));

// ---------- blocking ----------
dmsRouter.get("/blocks", h(async (req, res) => {
  const rows = await q<any>(
    `select u.id as user_id, u.username, u.display_name, u.avatar_version, u.accent, u.status_text
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
  res.json({ ok: true });
}));

dmsRouter.delete("/users/:userId/block", h(async (req, res) => {
  await q(`delete from user_blocks where blocker = $1 and blocked = $2`, [req.user!.id, req.params.userId]);
  res.json({ ok: true });
}));
