import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h } from "./http";
import { botEvents, ensurePlayCommand, registerHostedToken, revokeHostedTokens } from "./bots";
import { isHuddleAdmin } from "./perms";
import { isOnline } from "./realtime";

/**
 * Bot hosting, for Huddle Admins:
 *  - Python scripts attached to a bot. Huddle starts them whenever it starts (so on Render, after every deploy or restart)
 *    and again whenever a script changes. Each script signs in as its bot with a token Huddle makes for it.
 *  - A game attached to a bot. It plays inside chat when someone runs the bot's /play command.
 */

const MAX_SCRIPTS_PER_BOT = 10;
const MAX_SCRIPT_BYTES = 200_000;
const MAX_GAME_BYTES = 900_000;
const MAX_LOG_LINES = 300;
const MAX_QUICK_CRASHES = 5;
const SCRIPT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const isPython = (name: string) => name.endsWith(".py");
const REQUIREMENTS = "requirements.txt";

const GAMES_DIR = path.join(__dirname, "../games");
const ROOT = path.join(os.tmpdir(), "huddle-bots");

let hostPort = 3000;
let hostingOn = false;
let python: { ok: boolean; version: string | null } = { ok: false, version: null };

// ---------- the games that ship with Huddle ----------

export interface BuiltinGame { slug: string; title: string; file: string }

export function builtinGames(): BuiltinGame[] {
  try {
    return fs
      .readdirSync(GAMES_DIR)
      .filter((f) => /^[a-z0-9-]+\.html$/.test(f))
      .map((f) => {
        const html = fs.readFileSync(path.join(GAMES_DIR, f), "utf8");
        const title = /<title>([^<]{1,60})<\/title>/i.exec(html)?.[1]?.trim() || f.replace(/\.html$/, "");
        return { slug: f.replace(/\.html$/, ""), title, file: path.join(GAMES_DIR, f) };
      });
  } catch {
    return [];
  }
}

// ---------- running scripts ----------

type Status = "starting" | "running" | "finished" | "crashed" | "failed" | "stopped";
interface Proc {
  child: ChildProcess | null;
  status: Status;
  restarts: number;
  quickCrashes: number;
  startedAt: number | null;
  logs: string[];
  timer: NodeJS.Timeout | null;
  stopping: boolean;
}
const procs = new Map<string, Proc>(); // "<bot id>/<file name>"
const generation = new Map<string, number>(); // bumped on every (re)start of a bot, so late callbacks from an old run do nothing
const keyOf = (botId: string, file: string) => `${botId}/${file}`;

function logLine(p: Proc, text: string) {
  const stamp = new Date().toISOString().slice(11, 19);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    p.logs.push(`${stamp} ${line.slice(0, 2000)}`);
  }
  if (p.logs.length > MAX_LOG_LINES) p.logs.splice(0, p.logs.length - MAX_LOG_LINES);
}

function procFor(botId: string, file: string): Proc {
  const key = keyOf(botId, file);
  let p = procs.get(key);
  if (!p) {
    p = { child: null, status: "stopped", restarts: 0, quickCrashes: 0, startedAt: null, logs: [], timer: null, stopping: false };
    procs.set(key, p);
  }
  return p;
}

export function stopBot(botId: string) {
  generation.set(botId, (generation.get(botId) ?? 0) + 1);
  for (const [key, p] of procs) {
    if (!key.startsWith(botId + "/")) continue;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.stopping = true;
    if (p.child && !p.child.killed) p.child.kill("SIGKILL");
    p.child = null;
    p.status = "stopped";
  }
  revokeHostedTokens(botId);
}

export function stopAllBots() {
  const ids = new Set([...procs.keys()].map((k) => k.split("/")[0]));
  for (const id of ids) stopBot(id);
}

function launch(botId: string, file: string, dir: string, env: NodeJS.ProcessEnv, gen: number) {
  const p = procFor(botId, file);
  p.stopping = false;
  p.status = "starting";
  p.startedAt = Date.now();
  let child: ChildProcess;
  try {
    child = spawn("python3", ["-u", file], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e: any) {
    p.status = "failed";
    logLine(p, `Could not start: ${e?.message ?? e}`);
    return;
  }
  p.child = child;
  p.status = "running";
  const pipe = (stream: NodeJS.ReadableStream | null, tag: string) => {
    let rest = "";
    stream?.on("data", (d: Buffer) => {
      rest += d.toString("utf8");
      const cut = rest.lastIndexOf("\n");
      if (cut < 0) { if (rest.length > 4000) { logLine(p, tag + rest); rest = ""; } return; }
      logLine(p, rest.slice(0, cut).split("\n").map((l) => tag + l).join("\n"));
      rest = rest.slice(cut + 1);
    });
    stream?.on("end", () => { if (rest) logLine(p, tag + rest); });
  };
  pipe(child.stdout, "");
  pipe(child.stderr, "[err] ");
  child.on("error", (e: any) => {
    p.status = "failed";
    p.child = null;
    logLine(p, e?.code === "ENOENT" ? "python3 isn't installed on this server, so this script can't run." : `Could not start: ${e?.message ?? e}`);
  });
  child.on("exit", (code, signal) => {
    if (p.child !== child) return; // a newer run replaced this one
    p.child = null;
    if (p.stopping || generation.get(botId) !== gen) { p.status = "stopped"; return; }
    if (code === 0) { p.status = "finished"; logLine(p, "Finished (exit code 0)."); return; }
    p.status = "crashed";
    logLine(p, `Stopped with ${signal ? `signal ${signal}` : `exit code ${code}`}.`);
    const lived = Date.now() - (p.startedAt ?? Date.now());
    p.quickCrashes = lived > 60_000 ? 1 : p.quickCrashes + 1;
    if (p.quickCrashes > MAX_QUICK_CRASHES) {
      p.status = "failed";
      logLine(p, `It crashed ${MAX_QUICK_CRASHES} times in a row, so Huddle gave up. Fix the script and upload it again, or press Restart.`);
      return;
    }
    const wait = Math.min(30_000, 1000 * 2 ** p.quickCrashes);
    logLine(p, `Restarting in ${Math.round(wait / 1000)} seconds.`);
    p.timer = setTimeout(() => {
      p.timer = null;
      if (generation.get(botId) !== gen) return;
      p.restarts++;
      launch(botId, file, dir, env, gen);
    }, wait);
    p.timer.unref();
  });
}

/** (Re)starts every script of one bot. Safe to call at any time: the bot's old processes are stopped first. */
export async function startBot(botId: string) {
  stopBot(botId);
  if (!hostingOn) return;
  const gen = generation.get(botId) ?? 0;
  const bot = await one<{ username: string }>(`select username from users where id = $1 and bot_owner is not null and deleted_at is null`, [botId]);
  const scripts = await q<{ filename: string; content: string }>(`select filename, content from bot_scripts where bot_id = $1 order by filename`, [botId]);
  if (!bot || !scripts.length || generation.get(botId) !== gen) return;

  const dir = path.join(ROOT, botId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const s of scripts) fs.writeFileSync(path.join(dir, s.filename), s.content, "utf8");
  for (const s of scripts) { const p = procFor(botId, s.filename); p.logs = []; p.restarts = 0; p.quickCrashes = 0; }

  if (!python.ok) {
    for (const s of scripts) { const p = procFor(botId, s.filename); p.status = "failed"; logLine(p, "python3 isn't installed on this server, so scripts can't run."); }
    return;
  }

  const token = registerHostedToken(botId);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dir,
    LANG: process.env.LANG ?? "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONPATH: [path.join(dir, ".deps"), dir].join(path.delimiter),
    HUDDLE_URL: `http://127.0.0.1:${hostPort}`,
    HUDDLE_BOT_TOKEN: token,
    HUDDLE_BOT_ID: botId,
    HUDDLE_BOT_NAME: bot.username,
  };

  if (scripts.some((s) => s.filename === REQUIREMENTS)) {
    const p = procFor(botId, REQUIREMENTS);
    p.status = "running";
    p.startedAt = Date.now();
    logLine(p, "Installing requirements…");
    await new Promise<void>((resolve) => {
      const pip = spawn("python3", ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--target", path.join(dir, ".deps"), "-r", REQUIREMENTS], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => { logLine(p, "Installing took too long and was stopped."); pip.kill("SIGKILL"); }, 180_000);
      pip.stdout.on("data", (d: Buffer) => logLine(p, d.toString("utf8")));
      pip.stderr.on("data", (d: Buffer) => logLine(p, "[err] " + d.toString("utf8")));
      pip.on("error", (e) => { logLine(p, `Could not run pip: ${e.message}`); });
      pip.on("exit", (code) => {
        clearTimeout(timer);
        p.status = code === 0 ? "finished" : "failed";
        logLine(p, code === 0 ? "Requirements installed." : "Installing requirements failed. The scripts start anyway, but they may not work.");
        resolve();
      });
    });
    if (generation.get(botId) !== gen) return;
  }

  for (const s of scripts) if (isPython(s.filename)) launch(botId, s.filename, dir, env, gen);
}

/** Called once the server is listening. */
export async function startBotHost(port: number) {
  hostPort = port;
  if (process.env.BOT_HOST_DISABLED === "true") {
    console.log("Bot scripts: off (BOT_HOST_DISABLED=true)");
    return;
  }
  hostingOn = true;
  const v = spawnSync("python3", ["--version"], { encoding: "utf8" });
  python = v.status === 0 ? { ok: true, version: (v.stdout || v.stderr).trim().replace(/^Python\s+/i, "") } : { ok: false, version: null };
  const bots = await q<{ bot_id: string }>(`select distinct s.bot_id from bot_scripts s join users u on u.id = s.bot_id where u.deleted_at is null`);
  console.log(`Bot scripts: ${python.ok ? `Python ${python.version}` : "python3 not found"}, starting ${bots.length} bot(s)`);
  for (const b of bots) startBot(b.bot_id).catch((e) => console.error("Bot start failed", e));
}

botEvents.on("removed", (botId: string) => { stopBot(botId); fs.rmSync(path.join(ROOT, botId), { recursive: true, force: true }); });

// ---------- playing a bot's game ----------

/** Public. The game page runs in a sandbox with no access to Huddle, so a game (even one a Huddle Admin uploaded) can't touch anyone's account. */
export const gamesRouter = Router();
gamesRouter.get("/games/:botId", h(async (req, res) => {
  const id = String(req.params.botId);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(404, "Not found.");
  const game = await one<{ html: string }>(`select g.html from bot_games g join users u on u.id = g.bot_id where g.bot_id = $1 and u.deleted_at is null`, [id]);
  if (!game) throw new HttpError(404, "Not found.");
  res.setHeader("Content-Security-Policy", [
    "sandbox allow-scripts allow-popups",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src data: blob:",
    "media-src data: blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; "));
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(game.html);
}));

// ---------- Huddle Admin: scripts and games ----------

export const botHostRouter = Router();

botHostRouter.use("/huddle/bots", (req: Request, _res: Response, next: NextFunction) => {
  isHuddleAdmin(req.user!.id).then(
    (ok) => next(ok ? undefined : new HttpError(404, "Not found.")),
    next
  );
});

const log = (actorId: string, action: string, detail: object) =>
  q(`insert into huddle_admin_log(actor_id, action, detail) values ($1, $2, $3)`, [actorId, action, JSON.stringify(detail)]).catch(console.error);

async function devBot(botId: string) {
  const bot = await one<{ id: string; username: string }>(`select id, username from users where id = $1 and bot_owner is not null and deleted_at is null`, [botId]);
  if (!bot) throw new HttpError(404, "Bot not found.");
  return bot;
}

const procInfo = (botId: string, file: string) => {
  const p = procs.get(keyOf(botId, file));
  return { status: (p?.status ?? "stopped") as Status, restarts: p?.restarts ?? 0, startedAt: p?.startedAt ? new Date(p.startedAt).toISOString() : null };
};

botHostRouter.get("/huddle/bots", h(async (_req, res) => {
  const [bots, scripts] = await Promise.all([
    q<any>(
      `select u.id, u.username, u.display_name, u.bot_public, o.username as owner, g.title as game_title
         from users u join users o on o.id = u.bot_owner left join bot_games g on g.bot_id = u.id
        where u.bot_owner is not null and u.deleted_at is null order by lower(u.username)`
    ),
    q<any>(`select bot_id, filename, length(content)::int as size, updated_at from bot_scripts order by filename`),
  ]);
  res.json({
    hosting: { enabled: hostingOn, pythonVersion: python.ok ? python.version : null },
    limits: { scripts: MAX_SCRIPTS_PER_BOT, scriptKb: Math.round(MAX_SCRIPT_BYTES / 1000), gameKb: Math.round(MAX_GAME_BYTES / 1000) },
    builtinGames: builtinGames().map((g) => ({ slug: g.slug, title: g.title })),
    bots: bots.map((b) => ({
      id: b.id as string,
      username: b.username as string,
      displayName: (b.display_name ?? null) as string | null,
      owner: b.owner as string,
      public: !!b.bot_public,
      online: isOnline(b.id),
      game: b.game_title ? { title: b.game_title as string } : null,
      scripts: scripts
        .filter((s) => s.bot_id === b.id)
        .map((s) => ({ filename: s.filename as string, size: s.size as number, updatedAt: new Date(s.updated_at).toISOString(), ...procInfo(b.id, s.filename) })),
    })),
  });
}));

const scriptSchema = z.object({
  filename: z.string().regex(SCRIPT_NAME, "File names use letters, numbers, dots, dashes and underscores."),
  content: z.string().max(MAX_SCRIPT_BYTES, "That file is too large."),
});

botHostRouter.put("/huddle/bots/:botId/scripts", h(async (req, res) => {
  const bot = await devBot(String(req.params.botId));
  const { filename, content } = scriptSchema.parse(req.body);
  if (!isPython(filename) && filename !== REQUIREMENTS) throw new HttpError(400, "Upload a .py file (or a requirements.txt that lists the packages it needs).");
  if (content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_SCRIPT_BYTES) throw new HttpError(400, "That doesn't look like a text file, or it's too large.");
  const existing = await q<{ filename: string }>(`select filename from bot_scripts where bot_id = $1`, [bot.id]);
  if (!existing.some((e) => e.filename === filename) && existing.length >= MAX_SCRIPTS_PER_BOT) throw new HttpError(409, `A bot can have up to ${MAX_SCRIPTS_PER_BOT} files.`);
  await q(
    `insert into bot_scripts(bot_id, filename, content, uploaded_by) values ($1, $2, $3, $4)
     on conflict (bot_id, filename) do update set content = excluded.content, uploaded_by = excluded.uploaded_by, updated_at = now()`,
    [bot.id, filename, content, req.user!.id]
  );
  await log(req.user!.id, "bot.script.add", { bot: bot.username, filename });
  startBot(bot.id).catch(console.error);
  res.json({ ok: true });
}));

botHostRouter.delete("/huddle/bots/:botId/scripts/:filename", h(async (req, res) => {
  const bot = await devBot(String(req.params.botId));
  const filename = String(req.params.filename);
  const gone = await q(`delete from bot_scripts where bot_id = $1 and filename = $2 returning 1`, [bot.id, filename]);
  if (!gone.length) throw new HttpError(404, "File not found.");
  procs.delete(keyOf(bot.id, filename));
  await log(req.user!.id, "bot.script.remove", { bot: bot.username, filename });
  startBot(bot.id).catch(console.error);
  res.json({ ok: true });
}));

botHostRouter.post("/huddle/bots/:botId/restart", h(async (req, res) => {
  const bot = await devBot(String(req.params.botId));
  startBot(bot.id).catch(console.error);
  res.json({ ok: true });
}));

botHostRouter.get("/huddle/bots/:botId/logs", h(async (req, res) => {
  const bot = await devBot(String(req.params.botId));
  const file = z.string().regex(SCRIPT_NAME).parse(req.query.file);
  const p = procs.get(keyOf(bot.id, file));
  res.json({ lines: p?.logs ?? [], status: p?.status ?? "stopped" });
}));

const gameSchema = z.union([
  z.object({ builtin: z.string().regex(/^[a-z0-9-]+$/) }),
  z.object({ title: z.string().trim().min(1, "Give the game a name.").max(60), html: z.string().min(20, "That file is empty.") }),
]);

botHostRouter.put("/huddle/bots/:botId/game", h(async (req, res) => {
  const bot = await devBot(String(req.params.botId));
  const body = gameSchema.parse(req.body);
  let title: string;
  let html: string;
  if ("builtin" in body) {
    const g = builtinGames().find((x) => x.slug === body.builtin);
    if (!g) throw new HttpError(404, "That game isn't included with Huddle.");
    title = g.title;
    html = fs.readFileSync(g.file, "utf8");
  } else {
    title = body.title;
    html = body.html;
  }
  if (Buffer.byteLength(html, "utf8") > MAX_GAME_BYTES) throw new HttpError(400, `A game can be up to ${Math.round(MAX_GAME_BYTES / 1000)} KB. Put images and fonts inside the file or leave them out.`);
  await q(
    `insert into bot_games(bot_id, title, html) values ($1, $2, $3)
     on conflict (bot_id) do update set title = excluded.title, html = excluded.html, updated_at = now()`,
    [bot.id, title, html]
  );
  await ensurePlayCommand(bot.id);
  await log(req.user!.id, "bot.game.set", { bot: bot.username, title });
  res.json({ ok: true });
}));

botHostRouter.delete("/huddle/bots/:botId/game", h(async (req, res) => {
  const bot = await devBot(String(req.params.botId));
  await q(`delete from bot_games where bot_id = $1`, [bot.id]);
  await q(`delete from bot_commands where bot_id = $1 and name = 'play'`, [bot.id]);
  await log(req.user!.id, "bot.game.remove", { bot: bot.username });
  res.json({ ok: true });
}));

/**
 * Makes a public bot that has one of the games that ship with Huddle, so it can be added to any server. It belongs to the
 * admin who made it, like any bot, and needs no script: Huddle answers its /play command itself.
 */
botHostRouter.post("/huddle/bots/from-game", h(async (req, res) => {
  const { slug, username } = z
    .object({
      slug: z.string().regex(/^[a-z0-9-]+$/),
      username: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/, "Bot names are 3–20 letters, numbers, or underscores.").refine((u) => !["everyone", "here", "huddle"].includes(u.toLowerCase()), "That name is reserved."),
    })
    .parse(req.body);
  const g = builtinGames().find((x) => x.slug === slug);
  if (!g) throw new HttpError(404, "That game isn't included with Huddle.");
  let id: string;
  try {
    const bot = await one<{ id: string }>(
      `insert into users(username, password_hash, display_name, bot_owner, bot_description, bot_public) values ($1, '!', $2, $3, $4, true) returning id`,
      [username, g.title.slice(0, 32), req.user!.id, `Play ${g.title} right in the chat. Run /play.`.slice(0, 200)]
    );
    id = bot!.id;
  } catch (e: any) {
    if (e.code === "23505") throw new HttpError(409, "That name is taken.");
    throw e;
  }
  await q(`insert into bot_games(bot_id, title, html) values ($1, $2, $3)`, [id, g.title, fs.readFileSync(g.file, "utf8")]);
  await ensurePlayCommand(id);
  await log(req.user!.id, "bot.create", { bot: username, game: g.title });
  res.json({ ok: true, botId: id });
}));
