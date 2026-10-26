import crypto from "crypto";
import { Router } from "express";
import { hash, verify } from "@node-rs/argon2";
import { parse } from "cookie";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { mailEnabled, sendMail } from "./mail";
import { newSecret, otpauthUrl, seal, unseal, verifyTotp } from "./totp";

/**
 * Account security: email addresses, password reset, changing your password, and two-factor sign-in.
 *
 * - An email only counts once its owner has entered the code sent to it. Resets only ever go to a verified email.
 * - Codes are 6 digits, expire (15–30 minutes), work once, are stored hashed, and die after 5 wrong tries.
 * - Resetting a password signs the account out everywhere. If two-factor is on, a reset needs the authenticator
 *   (or recovery) code as well as the emailed code, so access to someone's inbox alone isn't enough.
 * - People without a verified email (or without email set up on the server) get reset codes from a Huddle Admin.
 */
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const normalizeCode = (c: string) => c.replace(/[\s-]/g, "").toUpperCase();
const sameHash = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ---------- one-time codes (email verification, password reset) ----------
type Purpose = "verify" | "reset";
const READABLE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1

function randomFrom(alphabet: string, n: number) {
  return Array.from({ length: n }, () => alphabet[crypto.randomInt(alphabet.length)]).join("");
}

/** kind "email": 6 digits for emailed codes. kind "admin": 8 letters/digits (shown as ABCD-EFGH) a Huddle Admin hands over. */
export async function issueCode(userId: string, purpose: Purpose, email: string | null, kind: "email" | "admin"): Promise<string> {
  const code = kind === "email" ? String(crypto.randomInt(1_000_000)).padStart(6, "0") : randomFrom(READABLE, 8);
  const salt = crypto.randomBytes(8).toString("hex");
  const minutes = kind === "admin" ? 60 : purpose === "verify" ? 15 : 30;
  await q(`delete from email_codes where user_id = $1 and purpose = $2`, [userId, purpose]);
  await q(
    `insert into email_codes(user_id, purpose, email, code_hash, salt, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [userId, purpose, email, sha(`${salt}:${normalizeCode(code)}`), salt, minutes]
  );
  return kind === "admin" ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

const MAX_ATTEMPTS = 5;
/** Every check uses up one of the code's 5 attempts (claimed atomically), whether or not it's right. */
async function checkCode(userId: string, purpose: Purpose, code: string, consume: boolean): Promise<{ email: string | null } | null> {
  const row = await one<{ id: string; email: string | null; code_hash: string; salt: string }>(
    `update email_codes set attempts = attempts + 1
      where id = (select id from email_codes where user_id = $1 and purpose = $2 and expires_at > now() order by created_at desc limit 1) and attempts < $3
      returning id, email, code_hash, salt`,
    [userId, purpose, MAX_ATTEMPTS]
  );
  if (!row || !sameHash(sha(`${row.salt}:${normalizeCode(code)}`), row.code_hash)) return null;
  if (consume) await q(`delete from email_codes where id = $1`, [row.id]);
  return { email: row.email };
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

/** Tells the account's verified email that something about its security changed. */
export async function notifyEmail(userId: string, subject: string, text: string) {
  const u = await one<{ email: string }>(`select email from users where id = $1 and email_verified_at is not null`, [userId]);
  if (u) void sendMail(u.email, subject, `${text}\n\nIf this wasn't you, reset your password and turn on two-factor sign-in right away.`);
}

async function requirePassword(userId: string, password: string) {
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

recoveryRouter.get("/config", (_req, res) => void res.json({ mail: mailEnabled }));

/** Finds an account by username, or by a verified email address. */
async function findAccount(identifier: string) {
  return one<{ id: string; username: string; email: string | null; totp: boolean }>(
    `select id, username, case when email_verified_at is not null then email end as email, totp_enabled_at is not null as totp
       from users
      where not is_bot and deleted_at is null and (lower(username) = $1 or (email_verified_at is not null and lower(email) = $1))
      limit 1`,
    [identifier]
  );
}

const identifierField = z.string().trim().min(1).max(254);
const passwordField = z.string().min(8, "Passwords need at least 8 characters.").max(128, "That password is too long.");

/** Always answers the same way, whether or not the account exists, so it can't be used to find out who has an account. */
recoveryRouter.post("/forgot", h(async (req, res) => {
  const { identifier } = z.object({ identifier: identifierField }).parse(req.body);
  const id = identifier.toLowerCase();
  rateLimit(`forgot:ip:${req.ip}`, 10, 3600_000);
  rateLimit(`forgot:id:${id}`, 3, 3600_000);
  res.json({ ok: true });
  if (!mailEnabled) return;
  void (async () => {
    const user = await findAccount(id);
    if (!user?.email) return;
    const code = await issueCode(user.id, "reset", user.email, "email");
    await sendMail(user.email, "Your Huddle password reset code", `Your Huddle password reset code is ${code}.\n\nIt works once and expires in 30 minutes. If you didn't ask for this, you can ignore this email; your password hasn't changed.`);
  })().catch(console.error);
}));

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
  await q(`delete from email_codes where user_id = $1 and purpose = 'reset'`, [user.id]);
  await notifyEmail(user.id, "Your Huddle password was reset", "Your Huddle password was just reset, and you were signed out everywhere.");
  res.json({ ok: true });
}));

// ---------- signed-in routes: email, password, two-factor ----------
export const securityRouter = Router();

securityRouter.get("/me/security", h(async (req, res) => {
  const id = req.user!.id;
  const u = await one<any>(
    `select email, email_verified_at, totp_enabled_at, (select count(*)::int from recovery_codes r where r.user_id = u.id and r.used_at is null) as recovery_left from users u where id = $1`,
    [id]
  );
  const pending = await one<{ email: string }>(`select email from email_codes where user_id = $1 and purpose = 'verify' and expires_at > now() order by created_at desc limit 1`, [id]);
  res.json({
    mail: mailEnabled,
    email: u.email_verified_at ? (u.email as string) : null,
    pendingEmail: pending?.email ?? null,
    totpEnabled: !!u.totp_enabled_at,
    recoveryLeft: u.recovery_left as number,
  });
}));

securityRouter.post("/me/email", h(async (req, res) => {
  const id = req.user!.id;
  const body = z.object({ email: z.string().trim().toLowerCase().email("That doesn't look like an email address.").max(254), password: z.string() }).parse(req.body);
  if (!mailEnabled) throw new HttpError(503, "Email isn't set up on this server.");
  rateLimit(`email:${id}`, 5, 3600_000);
  await requirePassword(id, body.password);
  if (await one(`select 1 from users where lower(email) = $1 and email_verified_at is not null and id <> $2`, [body.email, id])) throw new HttpError(409, "That email is already used by another account.");
  const code = await issueCode(id, "verify", body.email, "email");
  if (!(await sendMail(body.email, "Your Huddle verification code", `Your Huddle email verification code is ${code}.\n\nIt expires in 15 minutes. If you didn't ask for this, ignore this email.`)))
    throw new HttpError(502, "Couldn't send the email. Check the address and try again.");
  res.json({ ok: true });
}));

securityRouter.post("/me/email/verify", h(async (req, res) => {
  const id = req.user!.id;
  const { code } = z.object({ code: z.string().trim().min(4).max(20) }).parse(req.body);
  rateLimit(`emailverify:${id}`, 15, 3600_000);
  const row = await checkCode(id, "verify", code, true);
  if (!row?.email) throw new HttpError(400, "That code isn't right or has expired.");
  try {
    await q(`update users set email = $2, email_verified_at = now() where id = $1`, [id, row.email]);
  } catch (e: any) {
    if (e.code === "23505") throw new HttpError(409, "That email is already used by another account.");
    throw e;
  }
  res.json({ ok: true, email: row.email });
}));

securityRouter.delete("/me/email", h(async (req, res) => {
  const id = req.user!.id;
  const { password, code } = z.object({ password: z.string(), code: z.string().max(40).optional() }).parse(req.body);
  await requirePassword(id, password);
  await requireSecondFactor(id, code);
  await notifyEmail(id, "Email removed from your Huddle account", "This email address was removed from your Huddle account, so it can no longer be used to reset the password.");
  await q(`update users set email = null, email_verified_at = null where id = $1`, [id]);
  await q(`delete from email_codes where user_id = $1`, [id]);
  res.json({ ok: true });
}));

securityRouter.post("/me/password", h(async (req, res) => {
  const id = req.user!.id;
  const body = z.object({ current: z.string(), password: passwordField, code: z.string().max(40).optional() }).parse(req.body);
  await requirePassword(id, body.current);
  await requireSecondFactor(id, body.code);
  await q(`update users set password_hash = $2 where id = $1`, [id, await hash(body.password)]);
  const sid = parse(req.headers.cookie ?? "").sid;
  await q(`delete from sessions where user_id = $1 and token_hash <> $2`, [id, sid ? sha(sid) : ""]); // other devices are signed out; this one stays
  await notifyEmail(id, "Your Huddle password was changed", "Your Huddle password was just changed, and your other devices were signed out.");
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
  await notifyEmail(id, "Two-factor sign-in turned on", "Two-factor sign-in was just turned on for your Huddle account.");
  res.json({ ok: true, recoveryCodes });
}));

securityRouter.post("/me/2fa/disable", h(async (req, res) => {
  const id = req.user!.id;
  const { password, code } = z.object({ password: z.string(), code: z.string().max(40).optional() }).parse(req.body);
  await requirePassword(id, password);
  if (!(await has2fa(id))) throw new HttpError(400, "Two-factor sign-in isn't on.");
  await requireSecondFactor(id, code, true);
  await clearTwoFactor(id);
  await notifyEmail(id, "Two-factor sign-in turned off", "Two-factor sign-in was just turned off for your Huddle account.");
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
