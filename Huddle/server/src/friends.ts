import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { emitUser, statusOf } from "./realtime";

export const friendsRouter = Router();

/** Friendships are stored once per pair, smaller id first. */
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

export async function areFriends(a: string, b: string) {
  const [x, y] = pair(a, b);
  return !!(await one(`select 1 from friendships where user_a = $1 and user_b = $2`, [x, y]));
}
export type Friendship = "none" | "friends" | "outgoing" | "incoming";
export async function friendshipState(me: string, other: string): Promise<Friendship> {
  if (await areFriends(me, other)) return "friends";
  if (await one(`select 1 from friend_requests where from_id = $1 and to_id = $2`, [me, other])) return "outgoing";
  if (await one(`select 1 from friend_requests where from_id = $2 and to_id = $1`, [me, other])) return "incoming";
  return "none";
}
/** Blocking someone ends any friendship and pending requests. */
export async function dropFriendship(a: string, b: string) {
  const [x, y] = pair(a, b);
  await q(`delete from friendships where user_a = $1 and user_b = $2`, [x, y]);
  await q(`delete from friend_requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)`, [a, b]);
  emitUser(a, "friends.update", { event: "removed" });
  emitUser(b, "friends.update", { event: "removed" });
}

const userDto = (r: any) => ({
  id: r.id as string,
  username: r.username as string,
  displayName: (r.display_name ?? null) as string | null,
  avatarVersion: r.avatar_version as number,
  accent: (r.accent ?? null) as string | null,
  statusText: r.status_text as string,
  nameFont: (r.name_font ?? "default") as string,
  status: statusOf(r.id),
});
const cols = `u.id, u.username, u.display_name, u.avatar_version, u.accent, u.status_text, u.name_font`;

friendsRouter.get("/friends", h(async (req, res) => {
  const me = req.user!.id;
  const friends = await q(
    `select ${cols} from friendships f join users u on u.id = case when f.user_a = $1 then f.user_b else f.user_a end
      where (f.user_a = $1 or f.user_b = $1) and u.deleted_at is null order by lower(u.username)`,
    [me]
  );
  const incoming = await q(`select ${cols} from friend_requests r join users u on u.id = r.from_id where r.to_id = $1 and u.deleted_at is null order by r.created_at desc`, [me]);
  const outgoing = await q(`select ${cols} from friend_requests r join users u on u.id = r.to_id where r.from_id = $1 and u.deleted_at is null order by r.created_at desc`, [me]);
  res.json({ friends: friends.map(userDto), incoming: incoming.map(userDto), outgoing: outgoing.map(userDto) });
}));

async function makeFriends(a: string, b: string) {
  const [x, y] = pair(a, b);
  await tx(async (c) => {
    await q(`insert into friendships(user_a, user_b) values ($1, $2) on conflict do nothing`, [x, y], c);
    await q(`delete from friend_requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)`, [a, b], c);
  });
}

/** Send a request by user id (from a profile) or by username (from the Friends window). Needs a shared server, and mutual requests become friendships. */
friendsRouter.post("/friends/requests", h(async (req, res) => {
  const me = req.user!;
  rateLimit(`friendreq:${me.id}`, 30, 3600_000);
  const body = z.union([z.object({ userId: z.string().uuid() }), z.object({ username: z.string().trim().min(1).max(40) })]).parse(req.body);
  const target = await one<{ id: string; username: string; display_name: string | null }>(
    "userId" in body
      ? `select id, username, display_name from users where id = $1 and deleted_at is null and not is_bot`
      : `select id, username, display_name from users where lower(username) = lower($1) and deleted_at is null and not is_bot`,
    ["userId" in body ? body.userId : body.username]
  );
  const shared = target && (await one(
    `select 1 from memberships a join memberships b on a.server_id = b.server_id join servers s on s.id = a.server_id where a.user_id = $1 and b.user_id = $2 and not s.is_dm limit 1`,
    [me.id, target.id]
  ));
  if (!target || !shared) throw new HttpError(404, "You can only add people you share a server with.");
  if (target.id === me.id) throw new HttpError(400, "You can't add yourself.");
  if (await one(`select 1 from user_blocks where (blocker = $1 and blocked = $2) or (blocker = $2 and blocked = $1)`, [me.id, target.id]))
    throw new HttpError(403, "You can't send this person a friend request.");
  if (await areFriends(me.id, target.id)) throw new HttpError(409, "You're already friends.");
  if (await one(`select 1 from friend_requests where from_id = $1 and to_id = $2`, [target.id, me.id])) {
    await makeFriends(me.id, target.id);
    emitUser(target.id, "friends.update", { event: "accepted", userId: me.id });
    emitUser(me.id, "friends.update", { event: "accepted", userId: target.id });
    return void res.json({ state: "friends" satisfies Friendship });
  }
  const added = await q(`insert into friend_requests(from_id, to_id) values ($1, $2) on conflict do nothing returning 1`, [me.id, target.id]);
  if (added.length) {
    emitUser(target.id, "friends.update", { event: "request", userId: me.id, name: (await one<{ n: string }>(`select coalesce(display_name, username) as n from users where id = $1`, [me.id]))!.n });
    emitUser(me.id, "friends.update", { event: "sent" });
  }
  res.json({ state: "outgoing" satisfies Friendship });
}));

friendsRouter.post("/friends/requests/:userId/accept", h(async (req, res) => {
  const me = req.user!.id;
  const { userId } = req.params;
  const had = await q(`select 1 from friend_requests where from_id = $1 and to_id = $2`, [userId, me]);
  if (!had.length) throw new HttpError(404, "That friend request is gone.");
  await makeFriends(me, userId);
  emitUser(userId, "friends.update", { event: "accepted", userId: me });
  emitUser(me, "friends.update", { event: "accepted", userId });
  res.json({ ok: true });
}));

/** Declines an incoming request or cancels one you sent. */
friendsRouter.delete("/friends/requests/:userId", h(async (req, res) => {
  const me = req.user!.id;
  const { userId } = req.params;
  await q(`delete from friend_requests where (from_id = $1 and to_id = $2) or (from_id = $2 and to_id = $1)`, [me, userId]);
  emitUser(userId, "friends.update", { event: "removed" });
  emitUser(me, "friends.update", { event: "removed" });
  res.json({ ok: true });
}));

friendsRouter.delete("/friends/:userId", h(async (req, res) => {
  const me = req.user!.id;
  const [x, y] = pair(me, req.params.userId);
  await q(`delete from friendships where user_a = $1 and user_b = $2`, [x, y]);
  emitUser(req.params.userId, "friends.update", { event: "removed" });
  emitUser(me, "friends.update", { event: "removed" });
  res.json({ ok: true });
}));
