import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { dmList } from "./dms";
import { getMessageDto } from "./hydrate";
import { HttpError, h, rateLimit } from "./http";
import { isHuddleAdmin } from "./perms";
import { deleteServer, eraseAccount } from "./deletion";
import { clearTwoFactor, issueCode, notifyEmail } from "./security";
import { dropUser, emitServer, emitUser, joinAllServers, joinServerRooms, leaveUnjoinedServers } from "./realtime";

/**
 * Huddle Admin: a site-wide admin. Anyone who has it is an admin of every server (see membership() in perms.ts),
 * with no badge or marker anywhere, and can speak to the whole site through the built-in "Huddle" bot.
 *
 * What it does not do: read anyone's direct messages. DMs have no admins, and that doesn't change here.
 *
 * Accounts listed below (plus HUDDLE_ADMIN_USERNAMES, comma-separated) are granted Huddle Admin whenever the server
 * starts, if the account exists, and can't have it removed through the app. Granting is deliberately not tied to
 * registration, so nobody can get it by signing up with one of these names first.
 */
const FOUNDING_ADMINS = ["PixeledFaggy"];
const BOT_NAME = "Huddle";

export async function bootstrapHuddle() {
  const taken = await one<{ id: string; is_bot: boolean }>(`select id, is_bot from users where lower(username) = lower($1)`, [BOT_NAME]);
  if (!taken) {
    // '!' is not a valid password hash, so nobody can ever sign in as the bot.
    await q(`insert into users(username, password_hash, is_bot) values ($1, '!', true) on conflict do nothing`, [BOT_NAME]);
  } else if (!taken.is_bot) {
    console.error(`A user already has the username "${BOT_NAME}", so the Huddle bot is unavailable until that account is renamed.`);
  }

  const names = [...FOUNDING_ADMINS, ...(process.env.HUDDLE_ADMIN_USERNAMES ?? "").split(",")].map((s) => s.trim().replace(/^@/, "")).filter(Boolean);
  for (const name of names) {
    const granted = await q<{ id: string }>(
      `update users set huddle_admin = true, huddle_admin_locked = true where lower(username) = lower($1) and not is_bot and not (huddle_admin and huddle_admin_locked) returning id`,
      [name]
    );
    if (granted.length) console.log(`Huddle Admin granted to ${name}`);
  }
}

async function botId(): Promise<string> {
  const bot = await one<{ id: string }>(`select id from users where is_bot`);
  if (!bot) throw new HttpError(503, "The Huddle bot isn't available.");
  return bot.id;
}

const log = (actorId: string, action: string, detail: object) =>
  q(`insert into huddle_admin_log(actor_id, action, detail) values ($1, $2, $3)`, [actorId, action, JSON.stringify(detail)]).catch(console.error);

/** Inserts a message written by the bot and returns its id. */
async function insertBotMessage(channelId: string, bot: string, content: string, mentions: string[], everyone: boolean, c?: any) {
  const row = await one<{ id: string }>(
    `insert into messages(channel_id, author_id, content, mentions, mentions_everyone) values ($1, $2, $3, $4::uuid[], $5) returning id::text as id`,
    [channelId, bot, content, mentions, everyone],
    c
  );
  return row!.id;
}

/** Sends one DM from the bot, creating the conversation if there isn't one. Returns false if the person blocked the bot. */
async function deliverDm(bot: string, userId: string, content: string): Promise<boolean> {
  if (await one(`select 1 from user_blocks where blocker = $1 and blocked = $2`, [userId, bot])) return false;
  const key = [bot, userId].sort().join(":");
  let created = false;
  const found = await one<{ id: string; channel_id: string }>(
    `select s.id, (select c.id from channels c where c.server_id = s.id order by c.created_at limit 1) as channel_id from servers s where s.dm_key = $1`,
    [key]
  );
  let serverId = found?.id;
  let channelId = found?.channel_id;
  if (!serverId || !channelId) {
    ({ serverId, channelId, created } = await tx(async (c) => {
      const s = await one<{ id: string }>(
        `insert into servers(name, owner_id, is_dm, dm_key) values ('', $1, true, $2) on conflict (dm_key) where dm_key is not null do nothing returning id`,
        [bot, key],
        c
      );
      if (!s) {
        const existing = (await one<{ id: string; channel_id: string }>(
          `select s.id, (select c.id from channels c where c.server_id = s.id order by c.created_at limit 1) as channel_id from servers s where s.dm_key = $1`,
          [key],
          c
        ))!;
        return { serverId: existing.id, channelId: existing.channel_id, created: false };
      }
      await q(`insert into memberships(server_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')`, [s.id, bot, userId], c);
      const ch = await one<{ id: string }>(`insert into channels(server_id, name) values ($1, 'chat') returning id`, [s.id], c);
      return { serverId: s.id, channelId: ch!.id, created: true };
    }));
  }
  const messageId = await insertBotMessage(channelId!, bot, content, [userId], false);
  joinServerRooms(userId, serverId!);
  if (created) emitUser(userId, "dm.new", (await dmList(userId, serverId))[0]);
  emitServer(serverId!, "message.create", await getMessageDto(messageId, null));
  return true;
}

let broadcasting = false;

async function broadcastToEveryone(actorId: string, content: string, recipients: string[]) {
  const bot = await botId();
  let sent = 0, skipped = 0, failed = 0;
  for (const userId of recipients) {
    try {
      if (await deliverDm(bot, userId, content)) sent++;
      else skipped++;
    } catch (e) {
      failed++;
      console.error("Huddle broadcast failed for one recipient", e);
    }
  }
  await log(actorId, "broadcast.dms.done", { sent, skipped, failed });
}

export const huddleAdminRouter = Router();

/** Everyone else gets a plain 404, as if none of this exists. */
huddleAdminRouter.use("/huddle", (req: Request, _res: Response, next: NextFunction) => {
  isHuddleAdmin(req.user!.id).then(
    (ok) => next(ok ? undefined : new HttpError(404, "Not found.")),
    next
  );
});

huddleAdminRouter.get("/huddle/overview", h(async (_req, res) => {
  const [admins, servers, people, bans] = await Promise.all([
    q<any>(`select id, username, display_name, huddle_admin_locked as locked from users where huddle_admin order by lower(username)`),
    q<any>(
      `select s.id, s.name,
              (select count(*)::int from memberships m where m.server_id = s.id) as members,
              (select coalesce(json_agg(json_build_object('id', c.id, 'name', c.name) order by c.created_at), '[]'::json) from channels c where c.server_id = s.id) as channels
         from servers s where not s.is_dm order by s.created_at`
    ),
    one<{ n: number }>(`select count(*)::int as n from users where not is_bot and deleted_at is null`),
    q<any>(
      `select id, username, ban_reason, (banned_until = 'infinity') as permanent, case when banned_until = 'infinity' then null else banned_until end as until
         from users where banned_until > now() order by lower(username)`
    ),
  ]);
  res.json({
    admins: admins.map((a) => ({ id: a.id, username: a.username, displayName: a.display_name ?? null, locked: a.locked })),
    servers: servers.map((s) => ({ id: s.id, name: s.name, members: s.members, channels: s.channels })),
    people: people!.n,
    bans: bans.map((b) => ({ id: b.id, username: b.username, reason: b.ban_reason ?? null, permanent: b.permanent, until: b.until ? new Date(b.until).toISOString() : null })),
    broadcasting,
  });
}));

const contentSchema = z.string().trim().min(1, "Write a message first.").max(2000, "Messages can be up to 2000 characters.");
const sendSchema = z.discriminatedUnion("target", [
  z.object({ target: z.literal("dms"), content: contentSchema }),
  z.object({ target: z.literal("server"), serverId: z.string().uuid(), channelId: z.string().uuid().optional(), content: contentSchema }),
]);

/** Speak as "Huddle": to one server's channel, or to everyone in their DMs. */
huddleAdminRouter.post("/huddle/send", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`huddlesend:${user.id}`, 20, 60_000);
  const body = sendSchema.parse(req.body);
  const bot = await botId();

  if (body.target === "server") {
    const server = await one<{ id: string; name: string }>(`select id, name from servers where id = $1 and not is_dm`, [body.serverId]);
    if (!server) throw new HttpError(404, "Server not found.");
    const channel = body.channelId
      ? await one<{ id: string; name: string }>(`select id, name from channels where id = $1 and server_id = $2`, [body.channelId, server.id])
      : await one<{ id: string; name: string }>(`select id, name from channels where server_id = $1 order by created_at limit 1`, [server.id]);
    if (!channel) throw new HttpError(404, "Channel not found.");
    const everyone = /(?<![\w@])@everyone(?!\w)/.test(body.content);
    const messageId = await insertBotMessage(channel.id, bot, body.content, [], everyone);
    emitServer(server.id, "message.create", await getMessageDto(messageId, null));
    await log(user.id, "send.server", { serverId: server.id, channelId: channel.id });
    return void res.json({ ok: true, server: server.name, channel: channel.name });
  }

  rateLimit(`huddlebroadcast:${user.id}`, 5, 3600_000);
  if (broadcasting) throw new HttpError(409, "A broadcast is already being sent. Wait for it to finish.");
  const recipients = (await q<{ id: string }>(`select id from users where not is_bot and deleted_at is null and (banned_until is null or banned_until <= now()) order by created_at`)).map((r) => r.id);
  broadcasting = true;
  await log(user.id, "broadcast.dms", { recipients: recipients.length });
  // Sending to everyone can take a while, so it carries on after this request has been answered.
  void broadcastToEveryone(user.id, body.content, recipients)
    .catch(console.error)
    .finally(() => { broadcasting = false; });
  res.json({ ok: true, recipients: recipients.length });
}));

/** Gives Huddle Admin to anyone, by username. */
huddleAdminRouter.post("/huddle/admins", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`huddlegrant:${user.id}`, 30, 3600_000);
  const { username } = z.object({ username: z.string().trim().min(1).max(40) }).parse(req.body);
  const target = await one<{ id: string; username: string; is_bot: boolean; huddle_admin: boolean }>(
    `select id, username, is_bot, huddle_admin from users where lower(username) = lower($1) and deleted_at is null`,
    [username.replace(/^@/, "")]
  );
  if (!target) throw new HttpError(404, "No one has that username.");
  if (target.is_bot) throw new HttpError(400, "The Huddle bot can't be an admin.");
  if (!target.huddle_admin) {
    await q(`update users set huddle_admin = true where id = $1`, [target.id]);
    await joinAllServers(target.id);
    emitUser(target.id, "profile.update", { serverId: "", userId: target.id }); // their app refreshes its copy of their account
    await log(user.id, "grant", { targetId: target.id, username: target.username });
  }
  res.json({ ok: true, username: target.username });
}));

/** Takes Huddle Admin away. The founding accounts can't lose it. */
huddleAdminRouter.delete("/huddle/admins/:userId", h(async (req, res) => {
  const user = req.user!;
  const target = await one<{ id: string; username: string; huddle_admin: boolean; huddle_admin_locked: boolean }>(
    `select id, username, huddle_admin, huddle_admin_locked from users where id = $1`,
    [z.string().uuid().parse(req.params.userId)]
  );
  if (!target || !target.huddle_admin) throw new HttpError(404, "That person isn't a Huddle Admin.");
  if (target.huddle_admin_locked) throw new HttpError(403, "That account's Huddle Admin can't be removed here.");
  await q(`update users set huddle_admin = false where id = $1`, [target.id]);
  await leaveUnjoinedServers(target.id);
  emitUser(target.id, "profile.update", { serverId: "", userId: target.id });
  await log(user.id, "revoke", { targetId: target.id, username: target.username });
  res.json({ ok: true });
}));

// ---------- site-wide bans and account deletion ----------
/** The person an action is aimed at. Other Huddle Admins (and yourself) are off limits: remove the flag first. */
async function actionTarget(actorId: string, username: string) {
  const target = await one<{ id: string; username: string; is_bot: boolean; huddle_admin: boolean }>(
    `select id, username, is_bot, huddle_admin from users where lower(username) = lower($1) and deleted_at is null`,
    [username.trim().replace(/^@/, "")]
  );
  if (!target) throw new HttpError(404, "No one has that username.");
  if (target.is_bot) throw new HttpError(400, "That's the Huddle bot.");
  if (target.id === actorId) throw new HttpError(400, "You can't do that to yourself.");
  if (target.huddle_admin) throw new HttpError(403, "That person is a Huddle Admin. Remove that first (permanent ones can't be touched).");
  return target;
}

const usernameField = z.string().trim().min(1).max(40);

/** Bans a person from the whole site, for a while or for good. They're signed out right away. */
huddleAdminRouter.post("/huddle/users/ban", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`huddlemod:${user.id}`, 30, 3600_000);
  const body = z
    .object({
      username: usernameField,
      durationSeconds: z.number().int().min(60).max(5 * 365 * 86400).nullable(), // null = permanent
      reason: z.string().trim().max(200).optional(),
    })
    .parse(req.body);
  const target = await actionTarget(user.id, body.username);
  const row = await one<{ until: Date }>(
    `update users set banned_until = case when $2::float8 is null then 'infinity'::timestamptz else now() + make_interval(secs => $2::float8) end, ban_reason = $3
      where id = $1 returning banned_until as until`,
    [target.id, body.durationSeconds, body.reason || null]
  );
  await q(`delete from sessions where user_id = $1`, [target.id]);
  dropUser(target.id, "account.banned", { permanent: body.durationSeconds === null, until: body.durationSeconds === null ? null : row!.until.toISOString(), reason: body.reason || null });
  await log(user.id, "ban", { targetId: target.id, username: target.username, durationSeconds: body.durationSeconds, reason: body.reason });
  res.json({ ok: true, username: target.username });
}));

huddleAdminRouter.post("/huddle/users/:userId/unban", h(async (req, res) => {
  const id = z.string().uuid().parse(req.params.userId);
  const done = await q<{ username: string }>(`update users set banned_until = null, ban_reason = null where id = $1 and banned_until is not null returning username`, [id]);
  if (!done.length) throw new HttpError(404, "That person isn't banned.");
  await log(req.user!.id, "unban", { targetId: id, username: done[0].username });
  res.json({ ok: true });
}));

/**
 * Deletes someone's account completely (see eraseAccount). Typing their username again is required. If they own
 * servers, those have to be deleted with them (deleteOwnedServers); otherwise the request is refused and says so.
 */
huddleAdminRouter.post("/huddle/users/delete", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`huddlemod:${user.id}`, 30, 3600_000);
  const body = z
    .object({ username: usernameField, confirm: z.string(), deleteMessages: z.boolean().default(true), deleteOwnedServers: z.boolean().default(false) })
    .parse(req.body);
  const target = await actionTarget(user.id, body.username);
  if (body.confirm.trim().replace(/^@/, "").toLowerCase() !== target.username.toLowerCase()) throw new HttpError(400, "Type their username again to confirm.");
  const owned = await q<{ id: string; name: string }>(`select id, name from servers where owner_id = $1 and not is_dm order by name`, [target.id]);
  if (owned.length && !body.deleteOwnedServers)
    throw new HttpError(409, `${target.username} owns ${owned.length === 1 ? "a server" : `${owned.length} servers`} (${owned.map((s) => s.name).join(", ")}). Tick "Also delete servers they own" to continue.`);
  await log(user.id, "delete.account", { targetId: target.id, username: target.username, deleteMessages: body.deleteMessages, deletedServers: owned.map((s) => s.name) });
  for (const s of owned) await deleteServer(s.id);
  await eraseAccount(target.id, { deleteMessages: body.deleteMessages });
  res.json({ ok: true, username: target.username, deletedServers: owned.length });
}));

/**
 * Account recovery for people who can't use the normal route (no verified email, or email isn't set up on the server).
 * The code is shown once to the admin, who gives it to the person by some other channel after checking it's really them.
 * The person enters it under "Forgot password?" with their username.
 */
huddleAdminRouter.post("/huddle/users/reset-code", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`huddlemod:${user.id}`, 30, 3600_000);
  const { username } = z.object({ username: usernameField }).parse(req.body);
  const target = await actionTarget(user.id, username);
  const code = await issueCode(target.id, "reset", null, "admin");
  await log(user.id, "reset-code", { targetId: target.id, username: target.username });
  res.json({ ok: true, username: target.username, code, minutes: 60 });
}));

/** For someone who has lost their authenticator and recovery codes. Their password and email are unchanged. */
huddleAdminRouter.post("/huddle/users/disable-2fa", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`huddlemod:${user.id}`, 30, 3600_000);
  const { username } = z.object({ username: usernameField }).parse(req.body);
  const target = await actionTarget(user.id, username);
  await clearTwoFactor(target.id);
  await notifyEmail(target.id, "Two-factor sign-in was turned off by an admin", "A Huddle admin turned off two-factor sign-in for your account (for example, because you lost access to your authenticator).");
  await log(user.id, "disable-2fa", { targetId: target.id, username: target.username });
  res.json({ ok: true, username: target.username });
}));
