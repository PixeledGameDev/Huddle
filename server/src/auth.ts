import crypto from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { hash, verify } from "@node-rs/argon2";
import { parse } from "cookie";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";

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

export async function userFromCookie(header?: string): Promise<AuthUser | null> {
  const sid = parse(header ?? "").sid;
  if (!sid) return null;
  return one<AuthUser>(
    `select u.id, u.username from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > now()`,
    [sha(sid)]
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
  username: z.string().regex(/^[a-zA-Z0-9_]{3,20}$/, "Usernames are 3–20 letters, numbers, or underscores."),
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
      res.json({ user });
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
    const { username, password } = z.object({ username: z.string(), password: z.string() }).parse(req.body);
    const row = await one<{ id: string; username: string; password_hash: string }>(
      `select id, username, password_hash from users where lower(username) = lower($1)`,
      [username]
    );
    const ok = row ? await verify(row.password_hash, password).catch(() => false) : false;
    if (!row || !ok) throw new HttpError(401, "Wrong username or password.");
    await startSession(res, row.id);
    res.json({ user: { id: row.id, username: row.username } });
  })
);

authRouter.post(
  "/logout",
  h(async (req, res) => {
    const sid = parse(req.headers.cookie ?? "").sid;
    if (sid) await q(`delete from sessions where token_hash = $1`, [sha(sid)]);
    res.clearCookie("sid", { path: "/" });
    res.json({ ok: true });
  })
);

authRouter.get(
  "/me",
  h(async (req, res) => {
    const user = await userFromCookie(req.headers.cookie);
    if (!user) throw new HttpError(401, "Not signed in.");
    res.json({ user });
  })
);
