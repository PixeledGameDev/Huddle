import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Request } from "express";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, startSession } from "./auth";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { getProfile } from "./profiles";
import { requirePassword } from "./security";

/**
 * Passkeys: sign in with a fingerprint, face, PIN or security key instead of a password. A passkey with user verification is
 * already two factors (the device plus you), so signing in with one skips the authenticator-app step.
 */
const RP_NAME = "Huddle";
const MAX_PASSKEYS = 10;

/** Where the page is served from. PUBLIC_URL (e.g. https://huddle.example.com) wins; otherwise it comes from the request. */
function relyingParty(req: Request) {
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) {
    const u = new URL(configured);
    return { rpID: u.hostname, origin: u.origin };
  }
  return { rpID: req.hostname, origin: `${req.protocol}://${req.get("host")}` };
}

async function newChallenge(challenge: string, purpose: "register" | "login", userId: string | null) {
  await q(`delete from passkey_challenges where expires_at < now()`);
  const row = await one<{ id: string }>(`insert into passkey_challenges(user_id, challenge, purpose) values ($1, $2, $3) returning id`, [userId, challenge, purpose]);
  return row!.id;
}
/** Each challenge works once. */
async function takeChallenge(id: string, purpose: "register" | "login", userId: string | null) {
  const row = await one<{ challenge: string }>(
    `delete from passkey_challenges where id = $1 and purpose = $2 and expires_at > now() and user_id is not distinct from $3 returning challenge`,
    [id, purpose, userId]
  );
  if (!row) throw new HttpError(400, "That passkey request expired. Try again.");
  return row.challenge;
}

const idParam = z.string().uuid();

// ---------- signing in (public) ----------
export const passkeyAuthRouter = Router();

passkeyAuthRouter.post("/passkey/options", h(async (req, res) => {
  rateLimit(`pk:${req.ip}`, 30, 60_000);
  const { rpID } = relyingParty(req);
  // No username needed: the device offers the passkeys it holds for this site.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  res.json({ options, challengeId: await newChallenge(options.challenge, "login", null) });
}));

passkeyAuthRouter.post("/passkey/login", h(async (req, res) => {
  rateLimit(`pk:${req.ip}`, 30, 60_000);
  const body = z.object({ challengeId: idParam, response: z.any() }).parse(req.body);
  const response = body.response as AuthenticationResponseJSON;
  const challenge = await takeChallenge(body.challengeId, "login", null);
  const pk = await one<{ id: string; user_id: string; public_key: Buffer; counter: string; transports: string[] }>(
    `select id, user_id, public_key, counter, transports from passkeys where id = $1`,
    [String(response?.id ?? "")]
  );
  if (!pk) throw new HttpError(401, "That passkey isn't registered with Huddle.");
  const { rpID, origin } = relyingParty(req);
  let verified = false;
  let newCounter = Number(pk.counter);
  try {
    const r = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as any },
    });
    verified = r.verified;
    newCounter = r.authenticationInfo.newCounter;
  } catch {
    verified = false;
  }
  if (!verified) throw new HttpError(401, "Couldn't verify that passkey.");
  const u = await one<{ is_banned: boolean; ban_forever: boolean; banned_until: Date | null; ban_reason: string | null; deleted: boolean }>(
    `select coalesce(banned_until > now(), false) as is_banned, coalesce(banned_until = 'infinity', false) as ban_forever,
            case when banned_until = 'infinity' then null else banned_until end as banned_until, ban_reason, (deleted_at is not null) as deleted
       from users where id = $1`,
    [pk.user_id]
  );
  if (!u || u.deleted) throw new HttpError(401, "Couldn't verify that passkey.");
  if (u.is_banned) {
    const when = u.ban_forever || !u.banned_until ? "This account has been banned." : `This account is banned until ${u.banned_until.toUTCString()}.`;
    throw new HttpError(403, u.ban_reason ? `${when} Reason: ${u.ban_reason}` : when, { banned: true });
  }
  await q(`update passkeys set counter = $2, last_used_at = now() where id = $1`, [pk.id, newCounter]);
  await startSession(res, pk.user_id);
  res.json({ user: await getProfile(pk.user_id) });
}));

// ---------- managing your passkeys (signed in) ----------
export const passkeyRouter = Router();

const listFor = (userId: string) =>
  q<{ id: string; name: string; created_at: Date; last_used_at: Date | null }>(`select id, name, created_at, last_used_at from passkeys where user_id = $1 order by created_at`, [userId]).then((rows) =>
    rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null }))
  );

passkeyRouter.get("/me/passkeys", h(async (req, res) => {
  res.json({ passkeys: await listFor(req.user!.id) });
}));

passkeyRouter.post("/me/passkeys/options", h(async (req, res) => {
  const { id, username } = req.user!;
  const { password } = z.object({ password: z.string() }).parse(req.body);
  await requirePassword(id, password);
  const existing = await q<{ id: string; transports: string[] }>(`select id, transports from passkeys where user_id = $1`, [id]);
  if (existing.length >= MAX_PASSKEYS) throw new HttpError(400, `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
  const { rpID } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: username,
    userID: new TextEncoder().encode(id),
    attestationType: "none",
    excludeCredentials: existing.map((e) => ({ id: e.id, transports: e.transports })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" }, // "required" so it can sign in without typing a username
  });
  res.json({ options, challengeId: await newChallenge(options.challenge, "register", id) });
}));

passkeyRouter.post("/me/passkeys", h(async (req, res) => {
  const { id } = req.user!;
  const body = z.object({ challengeId: idParam, response: z.any(), name: z.string().trim().max(40).optional() }).parse(req.body);
  const challenge = await takeChallenge(body.challengeId, "register", id);
  const { rpID, origin } = relyingParty(req);
  let info;
  try {
    const r = await verifyRegistrationResponse({
      response: body.response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
    if (!r.verified) throw new Error("not verified");
    info = r.registrationInfo!;
  } catch {
    throw new HttpError(400, "Couldn't verify that passkey. Try again.");
  }
  const cred = info.credential;
  try {
    await q(`insert into passkeys(id, user_id, public_key, counter, transports, name) values ($1, $2, $3, $4, $5::text[], $6)`, [
      cred.id,
      id,
      Buffer.from(cred.publicKey),
      cred.counter,
      cred.transports ?? [],
      body.name || "Passkey",
    ]);
  } catch (e: any) {
    if (e.code === "23505") throw new HttpError(409, "That passkey is already added.");
    throw e;
  }
  res.json({ passkeys: await listFor(id) });
}));

passkeyRouter.delete("/me/passkeys/:id", h(async (req, res) => {
  const { id } = req.user!;
  const { password } = z.object({ password: z.string() }).parse(req.body);
  await requirePassword(id, password);
  await q(`delete from passkeys where id = $1 and user_id = $2`, [String(req.params.id), id]);
  res.json({ passkeys: await listFor(id) });
}));
