import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { hash, verify } from "@node-rs/argon2";
import { parse } from "cookie";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { getProfile } from "./profiles";
import { checkSecondFactor, has2fa } from "./security";

export interface AuthUser {
  id: string;
  username: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
  }
}

const SESSION_DAYS = 30;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

// Every request used to look the session up in the database. A short in-memory cache removes that round trip.
// Only successful lookups are cached, and anything that ends a session or bans someone clears it (see clearAuthCache).
const AUTH_TTL_MS = 15_000;
const authCache = new Map<string, { user: AuthUser; at: number }>();
export const clearAuthCache = () => authCache.clear();
setInterval(() => { const now = Date.now(); for (const [k, v] of authCache) if (now - v.at > AUTH_TTL_MS) authCache.delete(k); }, 30_000).unref();

export async function userFromCookie(header?: string): Promise<AuthUser | null> {
  const sid = parse(header ?? "").sid;
  if (!sid) return null;
  const key = sha(sid);
  const hit = authCache.get(key);
  if (hit && Date.now() - hit.at < AUTH_TTL_MS) return hit.user;
  const user = await lookupSession(key);
  if (user) authCache.set(key, { user, at: Date.now() });
  return user;
}

function lookupSession(hash: string): Promise<AuthUser | null> {
  return one<AuthUser>(
    `select u.id, u.username from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now() and (u.banned_until is null or u.banned_until <= now())`,
    [hash]
  );
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  userFromCookie(req.headers.cookie).then((u) => {
    if (!u) return next(new HttpError(401, "Sign in to continue."));
    req.user = u;
    next();
  }, next);
}

async function startSession(res: Response, userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  await q(`insert into sessions(token_hash, user_id, expires_at) values ($1, $2, now() + make_interval(days => $3))`, [
    sha(token),
    userId,
    SESSION_DAYS,
  ]);
  res.cookie("sid", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_DAYS * 86_400_000,
    path: "/",
  });
}

export async function cleanupSessions() {
  await q(`delete from sessions where expires_at < now()`);
}

const creds = z.object({
  username: z
    .string()
    .regex(/^[a-zA-Z0-9_]{3,20}$/, "Usernames are 3–20 letters, numbers, or underscores.")
    .refine((u) => !["everyone", "here", "huddle"].includes(u.toLowerCase()), "That username is reserved."),
  password: z.string().min(8, "Passwords need at least 8 characters.").max(128),
});

export const authRouter = Router();

authRouter.post(
  "/register",
  h(async (req, res) => {
    rateLimit(`auth:${req.ip}`, 10, 60_000);
    const { username, password } = creds.parse(req.body);
    try {
      const user = await one<AuthUser>(
        `insert into users(username, password_hash) values ($1, $2) returning id, username`,
        [username, await hash(password)]
      );
      await startSession(res, user!.id);
      res.json({ user: await getProfile(user!.id) });
    } catch (e: any) {
      if (e.code === "23505") throw new HttpError(409, "That username is taken.");
      throw e;
    }
  })
);

authRouter.post(
  "/login",
  h(async (req, res) => {
    rateLimit(`auth:${req.ip}`, 10, 60_000);
    const { username, password, code } = z.object({ username: z.string(), password: z.string(), code: z.string().max(40).optional() }).parse(req.body);
    const row = await one<{ id: string; username: string; password_hash: string; is_banned: boolean; ban_forever: boolean; banned_until: Date | null; ban_reason: string | null }>(
      `select id, username, password_hash, coalesce(banned_until > now(), false) as is_banned, coalesce(banned_until = 'infinity', false) as ban_forever,
              case when banned_until = 'infinity' then null else banned_until end as banned_until, ban_reason
         from users where lower(username) = lower($1)`,
      [username]
    );
    const ok = row ? await verify(row.password_hash, password).catch(() => false) : false;
    if (!row || !ok) throw new HttpError(401, "Wrong username or password.");
    if (row.is_banned) {
      const when = row.ban_forever || !row.banned_until ? "This account has been banned." : `This account is banned until ${row.banned_until.toUTCString()}.`;
      throw new HttpError(403, row.ban_reason ? `${when} Reason: ${row.ban_reason}` : when, { banned: true });
    }
    if (await has2fa(row.id)) {
      // The password was right, so the sign-in only needs the second factor. The app asks for it and sends the same request again with the code.
      if (!code) return void res.json({ needs2fa: true });
      rateLimit(`2fa:${row.id}`, 10, 900_000);
      if (!(await checkSecondFactor(row.id, code))) throw new HttpError(401, "That code isn't right.", { needs2fa: true });
    }
    await startSession(res, row.id);
    res.json({ user: await getProfile(row.id) });
  })
);

authRouter.post(
  "/logout",
  h(async (req, res) => {
    const sid = parse(req.headers.cookie ?? "").sid;
    if (sid) await q(`delete from sessions where token_hash = $1`, [sha(sid)]);
    clearAuthCache();
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  })
);

// Public numbers for the landing page. Cached briefly so a busy sign-in page can't hammer the database.
let statsCache: { at: number; value: { users: number; servers: number } } | null = null;
authRouter.get(
  "/stats",
  h(async (req, res) => {
    rateLimit(`stats:${req.ip}`, 60, 60_000);
    if (!statsCache || Date.now() - statsCache.at > 30_000) {
      const row = await one<{ users: string; servers: string }>(`select (select count(*) from users) as users, (select count(*) from servers) as servers`);
      statsCache = { at: Date.now(), value: { users: Number(row?.users ?? 0), servers: Number(row?.servers ?? 0) } };
    }
    res.set("Cache-Control", "public, max-age=30");
    res.json(statsCache.value);
  })
);

authRouter.get(
  "/me",
  h(async (req, res) => {
    const user = await userFromCookie(req.headers.cookie);
    if (!user) throw new HttpError(401, "Not signed in.");
    res.json({ user: await getProfile(user.id) });
  })
);
