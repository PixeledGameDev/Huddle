import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { assertCanWrite, assertNotDm, channelServer, requireMember, requirePerm } from "./perms";
import { requireChannelPerms } from "./channelperms";
import { getMessageDto } from "./hydrate";
import { dropUser, emitChannel, emitServer, emitUser, isOnline, joinServerRooms } from "./realtime";
import type { AuthUser } from "./auth";

/**
 * Developer bots: accounts that belong to a person and sign in with a token instead of a password.
 * A bot is a normal `users` row with `bot_owner` set, so it can be a server member, hold roles, be mentioned and send
 * messages like anyone else. (The built-in Huddle bot is different: it uses `is_bot`.)
 */

const MAX_BOTS_PER_USER = 10;
const TOKEN_PREFIX = "hb_";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");

const BOT_NAME = z
  .string()
  .regex(/^[a-zA-Z0-9_]{3,20}$/, "Bot names are 3–20 letters, numbers, or underscores.")
  .refine((u) => !["everyone", "here", "huddle"].includes(u.toLowerCase()), "That name is reserved.");

// ---------- token sign-in ----------

const AUTH_TTL_MS = 15_000;
const botCache = new Map<string, { user: AuthUser; at: number }>();
export const clearBotCache = () => botCache.clear();
setInterval(() => { const now = Date.now(); for (const [k, v] of botCache) if (now - v.at > AUTH_TTL_MS) botCache.delete(k); }, 30_000).unref();

/** Reads "Bot <token>" from an Authorization header (or a bare token from the socket handshake). */
export function botTokenFrom(header?: string | null): string | null {
  const m = /^Bot\s+(hb_[A-Za-z0-9_-]{20,100})$/.exec((header ?? "").trim());
  return m ? m[1] : null;
}

export async function userFromBotToken(token: string): Promise<(AuthUser & { isBot: true }) | null> {
  const key = sha(token);
  const hit = botCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_TTL_MS) return { ...hit.user, isBot: true };
  const user = await one<AuthUser>(
    `select u.id, u.username from bot_tokens t join users u on u.id = t.bot_id
      where t.token_hash = $1 and u.bot_owner is not null and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())`,
    [key]
  );
  if (!user) return null;
  botCache.set(key, { user, at: Date.now() });
  q(`update bot_tokens set last_used_at = now() where token_hash = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')`, [key]).catch(() => {});
  return { ...user, isBot: true };
}

export const isDevBot = async (userId: string) => !!(await one(`select 1 from users where id = $1 and bot_owner is not null`, [userId]));

/**
 * Bots only reach what a bot needs: reading the servers they're in, reading and sending messages, editing or
 * deleting their own, and reacting. Everything else (friends, DMs, account settings, creating servers...) is closed to them.
 */
const BOT_ALLOWED: [string, RegExp][] = [
  ["GET", /^\/bot\/me$/],
  ["GET", /^\/bot\/servers$/],
  ["GET", /^\/bot\/commands$/],
  ["PUT", /^\/bot\/commands$/],
  ["POST", /^\/interactions\/[0-9a-f-]{36}\/respond$/],
  ["GET", /^\/servers\/[0-9a-f-]{36}$/],
  ["GET", /^\/channels\/[0-9a-f-]{36}\/messages$/],
  ["POST", /^\/channels\/[0-9a-f-]{36}\/messages$/],
  ["PATCH", /^\/messages\/\d+$/],
  ["DELETE", /^\/messages\/\d+$/],
  ["PUT", /^\/messages\/\d+\/reactions\/[^/]+$/],
  ["DELETE", /^\/messages\/\d+\/reactions\/[^/]+$/],
];

/** Runs right after sign-in. A request made with a bot token that isn't on the list is refused. */
export function botGuard(req: Request, _res: Response, next: NextFunction) {
  if (!(req as any).isBot) return next();
  if (BOT_ALLOWED.some(([m, re]) => m === req.method && re.test(req.path))) return next();
  next(new HttpError(403, "Bots can't use this part of the API."));
}

// ---------- managing your bots ----------

export const botsRouter = Router();

/** Management is for people signed in with a password session; a bot can't create or manage bots. */
function humanOnly(req: Request) {
  if ((req as any).isBot) throw new HttpError(403, "Bots can't manage bots.");
}

const botDto = (r: any) => ({
  id: r.id as string,
  username: r.username as string,
  displayName: (r.display_name ?? null) as string | null,
  description: (r.bot_description ?? "") as string,
  public: !!r.bot_public,
  avatarVersion: r.avatar_version as number,
  createdAt: new Date(r.created_at).toISOString(),
  lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
  servers: (r.server_count ?? 0) as number,
});

const mineSql = `select u.id, u.username, u.display_name, u.bot_description, u.bot_public, u.avatar_version, u.created_at, t.last_used_at,
                        (select count(*)::int from memberships m join servers s on s.id = m.server_id where m.user_id = u.id and not s.is_dm) as server_count
                   from users u left join bot_tokens t on t.bot_id = u.id`;

botsRouter.get("/bots", h(async (req, res) => {
  humanOnly(req);
  res.json({ bots: (await q(`${mineSql} where u.bot_owner = $1 and u.deleted_at is null order by u.created_at`, [req.user!.id])).map(botDto) });
}));

botsRouter.post("/bots", h(async (req, res) => {
  humanOnly(req);
  const me = req.user!.id;
  rateLimit(`newbot:${me}`, 10, 3600_000);
  const { username, displayName, description } = z
    .object({ username: BOT_NAME, displayName: z.string().trim().min(1).max(32).optional(), description: z.string().trim().max(200).default("") })
    .parse(req.body);
  const count = await one<{ n: number }>(`select count(*)::int as n from users where bot_owner = $1 and deleted_at is null`, [me]);
  if (count!.n >= MAX_BOTS_PER_USER) throw new HttpError(409, `You can have up to ${MAX_BOTS_PER_USER} bots.`);
  const token = newToken();
  try {
    // "!" is not a valid password hash, so password sign-in can never succeed for a bot.
    const bot = await one<{ id: string }>(
      `insert into users(username, password_hash, display_name, bot_owner, bot_description) values ($1, '!', $2, $3, $4) returning id`,
      [username, displayName ?? null, me, description]
    );
    await q(`insert into bot_tokens(bot_id, token_hash) values ($1, $2)`, [bot!.id, sha(token)]);
    const row = await one(`${mineSql} where u.id = $1`, [bot!.id]);
    res.json({ bot: botDto(row), token }); // the token is shown only now
  } catch (e: any) {
    if (e.code === "23505") throw new HttpError(409, "That name is taken.");
    throw e;
  }
}));

async function ownedBot(req: Request) {
  const bot = await one<{ id: string; username: string }>(`select id, username from users where id = $1 and bot_owner = $2 and deleted_at is null`, [req.params.botId, req.user!.id]);
  if (!bot) throw new HttpError(404, "Bot not found.");
  return bot;
}

botsRouter.patch("/bots/:botId", h(async (req, res) => {
  humanOnly(req);
  const bot = await ownedBot(req);
  const { displayName, description, public: isPublic } = z
    .object({ displayName: z.string().trim().min(1).max(32).nullable().optional(), description: z.string().trim().max(200).optional(), public: z.boolean().optional() })
    .parse(req.body);
  await q(
    `update users set display_name = case when $2::boolean then $3 else display_name end, bot_description = coalesce($4, bot_description), bot_public = coalesce($5, bot_public) where id = $1`,
    [bot.id, displayName !== undefined, displayName ?? null, description ?? null, isPublic ?? null]
  );
  res.json({ bot: botDto((await one(`${mineSql} where u.id = $1`, [bot.id]))) });
}));

/** A new token replaces the old one at once: anything still using the old token is signed out. */
botsRouter.post("/bots/:botId/token", h(async (req, res) => {
  humanOnly(req);
  const bot = await ownedBot(req);
  rateLimit(`bottoken:${req.user!.id}`, 10, 3600_000);
  const token = newToken();
  await q(`insert into bot_tokens(bot_id, token_hash) values ($1, $2) on conflict (bot_id) do update set token_hash = excluded.token_hash, created_at = now(), last_used_at = null`, [bot.id, sha(token)]);
  clearBotCache();
  dropUser(bot.id);
  res.json({ token });
}));

/** Deleting a bot removes its sign-in and memberships. Its old messages stay, written by a deleted account, like anyone who deleted theirs. */
botsRouter.delete("/bots/:botId", h(async (req, res) => {
  humanOnly(req);
  const bot = await ownedBot(req);
  await q(`delete from bot_tokens where bot_id = $1`, [bot.id]);
  const servers = await q<{ server_id: string }>(`delete from memberships m using servers s where m.user_id = $1 and s.id = m.server_id and not s.is_dm returning m.server_id`, [bot.id]);
  await q(`delete from member_roles where user_id = $1`, [bot.id]);
  await q(`update users set deleted_at = now(), display_name = null, bot_description = '', username = 'deleted_' || substr(replace(id::text, '-', ''), 1, 12) where id = $1`, [bot.id]);
  clearBotCache();
  dropUser(bot.id);
  for (const s of servers) emitServer(s.server_id, "member.leave", { serverId: s.server_id, userId: bot.id });
  res.json({ ok: true });
}));

/** Puts a bot in a server you manage: one of yours, or any public bot. Bots can't join by invite, so this is the only way in. */
botsRouter.post("/servers/:serverId/bots", h(async (req, res) => {
  humanOnly(req);
  const { serverId } = req.params;
  const me = req.user!.id;
  await requirePerm(serverId, me, "manage_server");
  await assertNotDm(serverId);
  const { botId } = z.object({ botId: z.string().uuid() }).parse(req.body);
  const bot = await one<{ id: string }>(`select id from users where id = $1 and bot_owner is not null and deleted_at is null and (bot_owner = $2 or bot_public)`, [botId, me]);
  if (!bot) throw new HttpError(404, "Bot not found. You can add bots you own and bots that are public.");
  if (await one(`select 1 from server_bans where server_id = $1 and user_id = $2 and until > now()`, [serverId, bot.id])) throw new HttpError(403, "That bot is banned from this server.");
  const fresh = await q(`insert into memberships(server_id, user_id) values ($1, $2) on conflict do nothing returning 1`, [serverId, bot.id]);
  if (!fresh.length) throw new HttpError(409, "That bot is already in this server.");
  joinServerRooms(bot.id, serverId);
  emitServer(serverId, "member.join", { serverId, userId: bot.id });
  await q(`insert into audit_log(server_id, actor_id, action) values ($1, $2, 'member.join')`, [serverId, me]);
  res.json({ ok: true });
}));

// ---------- what a bot sees about itself ----------

botsRouter.get("/bot/me", h(async (req, res) => {
  if (!(req as any).isBot) throw new HttpError(403, "This is for bots.");
  const bot = await one(`${mineSql} where u.id = $1`, [req.user!.id]);
  res.json({ bot: botDto(bot) });
}));

botsRouter.get("/bot/servers", h(async (req, res) => {
  if (!(req as any).isBot) throw new HttpError(403, "This is for bots.");
  const servers = await q(
    `select s.id, s.name from memberships m join servers s on s.id = m.server_id where m.user_id = $1 and not s.is_dm order by s.name`,
    [req.user!.id]
  );
  res.json({ servers });
}));

/** Finds public bots by name, so someone can add a bot they don't own. Shows each bot's owner so people know who runs it. */
botsRouter.get("/bots/public", h(async (req, res) => {
  humanOnly(req);
  rateLimit(`botsearch:${req.user!.id}`, 30, 60_000);
  const term = z.string().trim().max(40).default("").parse(req.query.q ?? "");
  const rows = await q(
    `select u.id, u.username, u.display_name, u.bot_description, u.bot_public, u.avatar_version, u.created_at, null::timestamptz as last_used_at, 0 as server_count,
            o.username as owner_name
       from users u join users o on o.id = u.bot_owner
      where u.bot_owner is not null and u.bot_public and u.deleted_at is null
        and ($1 = '' or u.username ilike '%' || replace(replace($1, '%', ''), '_', '\\_') || '%' or u.display_name ilike '%' || replace(replace($1, '%', ''), '_', '\\_') || '%')
      order by u.username limit 20`,
    [term]
  );
  res.json({ bots: rows.map((r: any) => ({ ...botDto(r), owner: r.owner_name as string })) });
}));

// ---------- slash commands ----------

const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;
const optionSchema = z.object({
  name: z.string().regex(COMMAND_NAME, "Option names are 1–32 lowercase letters, numbers, - or _."),
  description: z.string().trim().max(100).default(""),
  /** "user" is a member of the server and "role" one of its roles: the message box shows a picker, and the bot gets the id. */
  type: z.enum(["string", "integer", "number", "boolean", "user", "role"]).default("string"),
  required: z.boolean().default(false),
  /** For text options: the only values allowed. The message box shows a drop-down. */
  choices: z.array(z.object({ name: z.string().trim().min(1).max(40), value: z.string().min(1).max(100) })).max(25).optional(),
});
const commandSchema = z.object({
  name: z.string().regex(COMMAND_NAME, "Command names are 1–32 lowercase letters, numbers, - or _."),
  description: z.string().trim().min(1).max(100),
  options: z.array(optionSchema).max(10).default([]),
});
type CommandOption = z.infer<typeof optionSchema>;

/** The bot sets its whole list of commands at once; anything not in the list is removed. */
botsRouter.put("/bot/commands", h(async (req, res) => {
  if (!(req as any).isBot) throw new HttpError(403, "This is for bots.");
  const botId = req.user!.id;
  rateLimit(`botcmds:${botId}`, 10, 60_000);
  const { commands } = z.object({ commands: z.array(commandSchema).max(50) }).parse(req.body);
  if (new Set(commands.map((c) => c.name)).size !== commands.length) throw new HttpError(400, "Two commands have the same name.");
  await replaceCommands(botId, commands);
  res.json({ commands });
}));

async function replaceCommands(botId: string, commands: z.infer<typeof commandSchema>[]) {
  await q(`delete from bot_commands where bot_id = $1 and not (name = any($2::text[]))`, [botId, commands.map((c) => c.name)]);
  for (const c of commands)
    await q(
      `insert into bot_commands(bot_id, name, description, options) values ($1, $2, $3, $4::jsonb)
       on conflict (bot_id, name) do update set description = excluded.description, options = excluded.options`,
      [botId, c.name, c.description, JSON.stringify(c.options)]
    );
}

botsRouter.get("/bot/commands", h(async (req, res) => {
  if (!(req as any).isBot) throw new HttpError(403, "This is for bots.");
  res.json({ commands: await q(`select name, description, options from bot_commands where bot_id = $1 order by name`, [req.user!.id]) });
}));

/** Every command available in a server (or DM): from each bot that is a member there. The message box offers these when someone types "/". */
botsRouter.get("/servers/:serverId/commands", h(async (req, res) => {
  humanOnly(req);
  await requireMember(req.params.serverId, req.user!.id);
  const rows = await q<any>(
    `select c.bot_id, u.username as bot_name, coalesce(u.display_name, u.username) as bot_display, c.name, c.description, c.options
       from memberships m join bot_commands c on c.bot_id = m.user_id join users u on u.id = m.user_id
      where m.server_id = $1 and u.deleted_at is null order by c.name, u.username`,
    [req.params.serverId]
  );
  res.json({ commands: rows.map((r) => ({ botId: r.bot_id, botName: r.bot_name, botDisplayName: r.bot_display, name: r.name, description: r.description, options: r.options })) });
}));

botsRouter.get("/channels/:channelId/commands", h(async (req, res) => {
  humanOnly(req);
  const serverId = await channelServer(req.params.channelId);
  await requireMember(serverId, req.user!.id);
  const rows = await q<any>(
    `select c.bot_id, u.username as bot_name, coalesce(u.display_name, u.username) as bot_display, c.name, c.description, c.options
       from memberships m join bot_commands c on c.bot_id = m.user_id join users u on u.id = m.user_id
      where m.server_id = $1 and u.deleted_at is null order by c.name, u.username`,
    [serverId]
  );
  const roles = await q<{ id: string; name: string }>(`select id, name from server_roles where server_id = $1 order by position desc`, [serverId]);
  res.json({ roles, commands: rows.map((r) => ({ botId: r.bot_id, botName: r.bot_name, botDisplayName: r.bot_display, name: r.name, description: r.description, options: r.options })) });
}));

/** Checks what someone typed against the command's options and returns clean values. */
async function cleanOptions(serverId: string, defs: CommandOption[], given: Record<string, unknown>) {
  const out: Record<string, string | number | boolean> = {};
  for (const d of defs) {
    const v = given[d.name];
    if (v === undefined || v === null || v === "") {
      if (d.required) throw new HttpError(400, `"${d.name}" is required.`);
      continue;
    }
    if (d.type === "boolean") {
      if (typeof v === "boolean") out[d.name] = v;
      else if (v === "true" || v === "false") out[d.name] = v === "true";
      else throw new HttpError(400, `"${d.name}" must be true or false.`);
    } else if (d.type === "integer" || d.type === "number") {
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n) || (d.type === "integer" && !Number.isInteger(n))) throw new HttpError(400, `"${d.name}" must be ${d.type === "integer" ? "a whole number" : "a number"}.`);
      out[d.name] = n;
    } else if (d.type === "user") {
      if (typeof v !== "string" || !(await one(`select 1 from memberships where server_id = $1 and user_id::text = $2`, [serverId, v]))) throw new HttpError(400, `"${d.name}" must be someone in this server.`);
      out[d.name] = v;
    } else if (d.type === "role") {
      if (typeof v !== "string" || !(await one(`select 1 from server_roles where server_id = $1 and id::text = $2`, [serverId, v]))) throw new HttpError(400, `"${d.name}" must be a role in this server.`);
      out[d.name] = v;
    } else {
      if (typeof v !== "string" || v.length > 1000) throw new HttpError(400, `"${d.name}" must be text up to 1000 characters.`);
      if (d.choices?.length && !d.choices.some((c) => c.value === v)) throw new HttpError(400, `"${d.name}" must be one of: ${d.choices.map((c) => c.name).join(", ")}.`);
      out[d.name] = v;
    }
  }
  return out;
}

const INTERACTION_MINUTES = 3;
const MAX_RESPONSES = 3;

/** Someone runs a command: the bot hears about it as an `interaction.create` event and answers with POST /interactions/:id/respond. */
botsRouter.post("/channels/:channelId/commands", h(async (req, res) => {
  humanOnly(req);
  const user = req.user!;
  const { channelId } = req.params;
  rateLimit(`cmd:${user.id}`, 10, 10_000);
  const body = z.object({ botId: z.string().uuid(), name: z.string().regex(COMMAND_NAME), options: z.record(z.unknown()).default({}) }).parse(req.body);
  const serverId = await channelServer(channelId);
  const me = await requireMember(serverId, user.id);
  await assertCanWrite(serverId, user.id);
  await requireChannelPerms(channelId, serverId, user.id, me, "send_messages");
  const cmd = await one<{ options: CommandOption[] }>(
    `select c.options from bot_commands c join memberships m on m.user_id = c.bot_id and m.server_id = $2
       join users u on u.id = c.bot_id where c.bot_id = $1 and c.name = $3 and u.deleted_at is null`,
    [body.botId, serverId, body.name]
  );
  if (!cmd) throw new HttpError(404, "That command isn't available here.");
  if (!isOnline(body.botId)) throw new HttpError(503, "That bot is offline right now.");
  const options = await cleanOptions(serverId, cmd.options, body.options);
  const row = await one<{ id: string }>(
    `insert into interactions(bot_id, channel_id, user_id, command, options) values ($1, $2, $3, $4, $5::jsonb) returning id`,
    [body.botId, channelId, user.id, body.name, JSON.stringify(options)]
  );
  const author = await one<{ username: string; display_name: string | null }>(`select username, display_name from users where id = $1`, [user.id]);
  // For "user" and "role" options the bot is told their names too, so it doesn't have to look them up.
  const resolved: { users: Record<string, { username: string; displayName: string | null }>; roles: Record<string, string> } = { users: {}, roles: {} };
  for (const d of cmd.options) {
    const v = options[d.name];
    if (typeof v !== "string") continue;
    if (d.type === "user") {
      const u = await one<{ username: string; display_name: string | null }>(`select username, display_name from users where id::text = $1`, [v]);
      if (u) resolved.users[v] = { username: u.username, displayName: u.display_name };
    } else if (d.type === "role") {
      const r = await one<{ name: string }>(`select name from server_roles where id::text = $1`, [v]);
      if (r) resolved.roles[v] = r.name;
    }
  }
  emitUser(body.botId, "interaction.create", {
    id: row!.id,
    command: body.name,
    options,
    resolved,
    channelId,
    serverId,
    user: { id: user.id, username: author!.username, displayName: author!.display_name },
    expiresInSeconds: INTERACTION_MINUTES * 60,
  });
  res.json({ interactionId: row!.id });
}));

/** The bot answers a command: a message in the same channel, marked as a reply to the command. Up to three answers within three minutes. */
botsRouter.post("/interactions/:id/respond", h(async (req, res) => {
  if (!(req as any).isBot) throw new HttpError(403, "This is for bots.");
  const botId = req.user!.id;
  rateLimit(`botresp:${botId}`, 30, 10_000);
  const { content } = z.object({ content: z.string().trim().min(1, "Write a response.").max(2000) }).parse(req.body);
  const it = await one<{ channel_id: string; user_id: string; command: string; responses: number }>(
    `update interactions set responses = responses + 1
      where id = $1 and bot_id = $2 and responses < $3 and created_at > now() - make_interval(mins => $4)
      returning channel_id, user_id, command, responses`,
    [req.params.id, botId, MAX_RESPONSES, INTERACTION_MINUTES]
  );
  if (!it) throw new HttpError(404, "That command has expired or was already answered.");
  const serverId = await channelServer(it.channel_id);
  await requireMember(serverId, botId); // the bot may have been removed since
  const msg = await one<{ id: string }>(
    `insert into messages(channel_id, author_id, content, mentions, via_command, via_user) values ($1, $2, $3, $4::uuid[], $5, $6) returning id::text as id`,
    [it.channel_id, botId, content, [it.user_id], it.command, it.user_id]
  );
  const message = await getMessageDto(msg!.id, null);
  await emitChannel(serverId, it.channel_id, "message.create", message);
  res.json({ message });
}));

export async function sweepInteractions() {
  await q(`delete from interactions where created_at < now() - interval '1 hour'`);
}
