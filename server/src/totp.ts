import crypto from "crypto";

/**
 * Time-based one-time passwords (RFC 6238), the 6-digit codes used by Google Authenticator, Authy, 1Password and so on,
 * built on Node's own crypto so there's nothing extra to install.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of text.replace(/[\s=-]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 15;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/**
 * Checks a code against the current time step and one step either side (for clock drift). Returns the matching step
 * (so the caller can refuse to accept the same code twice), or null.
 */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let secret: Buffer;
  try {
    secret = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const step = Math.floor(now / 1000 / STEP_SECONDS);
  let match: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    const expected = Buffer.from(hotp(secret, s));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) match = s; // no early exit, so timing doesn't reveal which step matched
  }
  return match;
}

export const otpauthUrl = (username: string, secret: string) =>
  `otpauth://totp/Huddle:${encodeURIComponent(username)}?secret=${secret}&issuer=Huddle`;

// ---- keeping the secret safe in the database
// With AUTH_SECRET set, authenticator secrets are encrypted at rest (AES-256-GCM). Without it they're stored as plain
// text, which still works but means a database leak would expose them. Changing AUTH_SECRET later makes existing
// authenticator setups unreadable, so people would need to be given a 2FA reset.
const authSecret = process.env.AUTH_SECRET;
const key = authSecret ? crypto.scryptSync(authSecret, "huddle-totp-v1", 32) : null;

export function seal(plain: string): string {
  if (!key) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
}

export function unseal(stored: string): string {
  if (stored.startsWith("plain:")) return stored.slice(6);
  if (!stored.startsWith("v1:") || !key) throw new Error("Can't read the stored authenticator secret (is AUTH_SECRET set?)");
  const raw = Buffer.from(stored.slice(3), "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
