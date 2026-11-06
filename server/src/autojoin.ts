import { q } from "./db";
import { emitServer, emitUser, joinServerRooms } from "./realtime";

/**
 * Auto-join servers: Huddle Admins pick servers that everyone is added to. New accounts join them when they register, and when
 * a server is added to the list, everyone who already has an account is added too. Leaving afterwards sticks: it only happens
 * at sign-up and at the moment a server is added. People banned from that server are skipped.
 * These joins aren't written to the server's activity log: thousands of "joined" lines at once would only bury it.
 */
export const MAX_AUTO_JOIN = 5;

/** Called when an account is created. Never throws: signing up must not fail because of this. */
export async function autoJoinNewUser(userId: string) {
  try {
    const rows = await q<{ server_id: string }>(
      `insert into memberships(server_id, user_id)
         select a.server_id, $1 from auto_join_servers a join servers s on s.id = a.server_id where not s.is_dm
       on conflict do nothing returning server_id`,
      [userId]
    );
    for (const r of rows) {
      joinServerRooms(userId, r.server_id);
      emitServer(r.server_id, "member.join", { serverId: r.server_id, userId });
    }
  } catch (e) {
    console.error("Couldn't add a new account to the auto-join servers", e);
  }
}

/** Adds every existing account to the server (one statement), and returns who was newly added. */
export async function addEveryoneTo(serverId: string): Promise<string[]> {
  const rows = await q<{ user_id: string }>(
    `insert into memberships(server_id, user_id)
       select $1, u.id from users u
        where not u.is_bot and u.deleted_at is null
          and not exists (select 1 from server_bans b where b.server_id = $1 and b.user_id = u.id and b.until > now())
     on conflict do nothing returning user_id`,
    [serverId]
  );
  return rows.map((r) => r.user_id);
}

/** Lets the people who were just added hear about it live: their sockets start listening to the server and their server list refreshes. */
export async function announceAdded(serverId: string, userIds: string[]) {
  let n = 0;
  for (const id of userIds) {
    joinServerRooms(id, serverId);
    emitUser(id, "server.update", { serverId });
    if (++n % 200 === 0) await new Promise((r) => setImmediate(r)); // don't hog the server while a big list is announced
  }
  emitServer(serverId, "server.update", { serverId });
}
