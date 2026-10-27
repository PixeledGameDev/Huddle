import { clearAuthCache } from "./auth";
import crypto from "crypto";
import { Router } from "express";
import { hash, verify } from "@node-rs/argon2";
import { parse } from "cookie";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { newSecret, otpauthUrl, seal, unseal, verifyTotp } from "./totp";

/**
 * Account security: password reset, changing your password, and two-factor sign-in.
 *
 * - There is no email. Someone who forgets their password asks a Huddle Admin for a reset code.
 * - Reset codes are 8 letters/digits, last an hour, work once, are stored hashed, and die after 5 wrong tries.
 * - Resetting a password signs the account out everywhere. If two-factor is on, a reset needs the authenticator
 *   (or recovery) code as well as the reset code.
 */
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeCode = (c: string) => c.replace(/[\s-]/g, "").toUpperCase();
const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- one-time codes (password reset) ----------
type Purpose = "reset";
const READABLE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

function randomFrom(alphabet: string, n: number) {
  return Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

/** A reset code a Huddle Admin hands over: 8 letters/digits, shown as ABCD-EFGH, good for an hour. */
export async function issueCode(userId: string, purpose: Purpose): Promise<string> {
  const code = randomFrom(READABLE, 8);
  const salt = crypto.randomBytes(8).toString("hex");
  await q(`delete from email_codes where user_id = $1 and purpose = $2`, [userId, purpose]); // the table keeps its old name
  await q(
    `insert into email_codes(user_id, purpose, email, code_hash, salt, expires_at) values ($1, $2, null, $3, $4, now() + interval '60 minutes')`,
    [userId, purpose, sha(`${salt}:${normalizeCode(code)}`), salt]
  );
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

const MAX_ATTEMPTS = 5;
/** Every check uses up one of the code's 5 attempts (claimed atomically), whether or not it's right. */
async function checkCode(userId: string, purpose: Purpose, code: string, consume: boolean): Promise<boolean> {
  const row = await one<{ id: string; code_hash: string; salt: string }>(
    `update email_codes set attempts = attempts + 1
      where id = (select id from email_codes where user_id = $1 and purpose = $2 and expires_at > now() order by created_at desc limit 1) and attempts < $3
      returning id, code_hash, salt`,
    [userId, purpose, MAX_ATTEMPTS]
  );
  if (!row || !sameHash(sha(`${row.salt}:${normalizeCode(code)}`), row.code_hash)) return false;
  if (consume) await q(`delete from email_codes where id = $1`, [row.id]);
  return true;
}

// ---------- second factor: authenticator code or recovery code ----------
export async function has2fa(userId: string) {
  return !!(await one(`select 1 from users where id = $1 and totp_enabled_at is not null`, [userId]));
}

/** For an account with two-factor on: is this a valid, unused authenticator code or recovery code? */
export async function checkSecondFactor(userId: string, raw: string): Promise<boolean> {
  const code = normalizeCode(raw);
  if (/^\d{6}$/.test(code)) {
    const u = await one<{ totp_secret: string }>(`select totp_secret from users where id = $1 and totp_enabled_at is not null`, [userId]);
    if (!u?.totp_secret) return false;
    const step = verifyTotp(unseal(u.totp_secret), code);
    if (step === null) return false;
    // A code works once: the step can only move forward.
    return !!(await one(`update users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2) returning id`, [userId, step]));
  }
  if (/^[A-Z0-9]{10}$/.test(code))
    return !!(await one(`update recovery_codes set used_at = now() where user_id = $1 and code_hash = $2 and used_at is null returning 1`, [userId, sha(code)]));
  return false;
}

async function newRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, () => randomFrom(READABLE, 10));
  await q(`delete from recovery_codes where user_id = $1`, [userId]);
  for (const c of codes) await q(`insert into recovery_codes(user_id, code_hash) values ($1, $2)`, [userId, sha(c)]);
  return codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`);
}

export async function clearTwoFactor(userId: string) {
  await q(`update users set totp_secret = null, totp_pending = null, totp_enabled_at = null, totp_last_step = null where id = $1`, [userId]);
  await q(`delete from recovery_codes where user_id = $1`, [userId]);
}

export async function requirePassword(userId: string, password: string) {
  rateLimit(`pw:${userId}`, 10, 900_000);
  const r = await one<{ password_hash: string }>(`select password_hash from users where id = $1`, [userId]);
  if (!r || !(await verify(r.password_hash, password).catch(() => false))) throw new HttpError(403, "That password isn't right.");
}

export async function requireSecondFactor(userId: string, code: string | undefined, always = false) {
  if (!always && !(await has2fa(userId))) return;
  if (!code) throw new HttpError(400, "Enter the code from your authenticator app.", { needs2fa: true });
  rateLimit(`2fa:${userId}`, 10, 900_000);
  if (!(await checkSecondFactor(userId, code))) throw new HttpError(403, "That authenticator or recovery code isn't right.", { needs2fa: true });
}

// ---------- public routes: forgotten password ----------
export const recoveryRouter = Router();

/** Finds an account by username. */
async function findAccount(identifier: string) {
  return one<{ id: string; username: string; totp: boolean }>(
    `select id, username, totp_enabled_at is not null as totp from users where not is_bot and deleted_at is null and lower(username) = $1 limit 1`,
    [identifier]
  );
}

const identifierField = z.string().trim().min(1).max(254);
const passwordField = z.string().min(8, "Passwords need at least 8 characters.").max(128, "That password is too long.");

recoveryRouter.post("/reset", h(async (req, res) => {
  const body = z.object({ identifier: identifierField, code: z.string().trim().min(4).max(20), password: passwordField, totp: z.string().max(40).optional() }).parse(req.body);
  const id = body.identifier.toLowerCase();
  rateLimit(`reset:ip:${req.ip}`, 20, 3600_000);
  rateLimit(`reset:id:${id}`, 15, 3600_000);
  const bad = new HttpError(400, "That code isn't right or has expired.");
  const user = await findAccount(id);
  if (!user) throw bad;
  if (!(await checkCode(user.id, "reset", body.code, false))) throw bad;
  if (user.totp) {
    if (!body.totp) throw new HttpError(400, "This account uses two-factor sign-in. Enter your authenticator code (or a recovery code) too.", { needs2fa: true });
    rateLimit(`2fa:${user.id}`, 10, 900_000);
    if (!(await checkSecondFactor(user.id, body.totp))) throw new HttpError(400, "That authenticator or recovery code isn't right.", { needs2fa: true });
  }
  if (!(await checkCode(user.id, "reset", body.code, true))) throw bad;
  await q(`update users set password_hash = $2 where id = $1`, [user.id, await hash(body.password)]);
  await q(`delete from sessions where user_id = $1`, [user.id]);
  clearAuthCache();
  await q(`delete from email_codes where user_id = $1 and purpose = 'reset'`, [user.id]);
  res.json({ ok: true });
}));

// ---------- signed-in routes: password, two-factor ----------
export const securityRouter = Router();

securityRouter.get("/me/security", h(async (req, res) => {
  const id = req.user!.id;
  const u = await one<any>(
    `select totp_enabled_at, (select count(*)::int from recovery_codes r where r.user_id = u.id and r.used_at is null) as recovery_left from users u where id = $1`,
    [id]
  );
  res.json({
    totpEnabled: !!u.totp_enabled_at,
    recoveryLeft: u.recovery_left as number,
  });
}));

securityRouter.post("/me/password", h(async (req, res) => {
  const id = req.user!.id;
  const body = z.object({ current: z.string(), password: passwordField, code: z.string().max(40).optional() }).parse(req.body);
  await requirePassword(id, body.current);
  await requireSecondFactor(id, body.code);
  await q(`update users set password_hash = $2 where id = $1`, [id, await hash(body.password)]);
  const sid = parse(req.headers.cookie ?? "").sid;
  await q(`delete from sessions where user_id = $1 and token_hash <> $2`, [id, sid ? sha(sid) : ""]); // other devices are signed out; this one stays
  clearAuthCache();
  res.json({ ok: true });
}));

securityRouter.post("/me/2fa/setup", h(async (req, res) => {
  const { id, username } = req.user!;
  const { password } = z.object({ password: z.string() }).parse(req.body);
  await requirePassword(id, password);
  if (await has2fa(id)) throw new HttpError(409, "Two-factor sign-in is already on.");
  const secret = newSecret();
  await q(`update users set totp_pending = $2 where id = $1`, [id, seal(secret)]);
  res.json({ secret, uri: otpauthUrl(username, secret) });
}));

securityRouter.post("/me/2fa/enable", h(async (req, res) => {
  const id = req.user!.id;
  const { code } = z.object({ code: z.string().trim().min(6).max(10) }).parse(req.body);
  rateLimit(`2fa:${id}`, 10, 900_000);
  const u = await one<{ totp_pending: string | null }>(`select totp_pending from users where id = $1 and totp_enabled_at is null`, [id]);
  if (!u?.totp_pending) throw new HttpError(400, "Start the setup again.");
  const step = verifyTotp(unseal(u.totp_pending), normalizeCode(code));
  if (step === null) throw new HttpError(400, "That code isn't right. Check that the time on your phone is correct and try the newest code.");
  await q(`update users set totp_secret = totp_pending, totp_pending = null, totp_enabled_at = now(), totp_last_step = $2 where id = $1`, [id, step]);
  const recoveryCodes = await newRecoveryCodes(id);
  res.json({ ok: true, recoveryCodes });
}));

securityRouter.post("/me/2fa/disable", h(async (req, res) => {
  const id = req.user!.id;
  const { password, code } = z.object({ password: z.string(), code: z.string().max(40).optional() }).parse(req.body);
  await requirePassword(id, password);
  if (!(await has2fa(id))) throw new HttpError(400, "Two-factor sign-in isn't on.");
  await requireSecondFactor(id, code, true);
  await clearTwoFactor(id);
  res.json({ ok: true });
}));

securityRouter.post("/me/2fa/recovery", h(async (req, res) => {
  const id = req.user!.id;
  const { password, code } = z.object({ password: z.string(), code: z.string().max(40).optional() }).parse(req.body);
  await requirePassword(id, password);
  if (!(await has2fa(id))) throw new HttpError(400, "Two-factor sign-in isn't on.");
  await requireSecondFactor(id, code, true);
  res.json({ ok: true, recoveryCodes: await newRecoveryCodes(id) });
}));
