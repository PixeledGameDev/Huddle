/**
 * Turns what someone typed into the address of their Huddle server, or returns null.
 * https is required, except for this computer (localhost / 127.0.0.1 / [::1]) where plain http is fine for development.
 * Only the origin is kept, so pasting a link to a channel or invite still works.
 */
function normalizeServerUrl(input) {
  let text = String(input ?? "").trim();
  if (!text || text.length > 300) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.username || u.password) return null;
  if (!local && !u.hostname.includes(".")) return null; // a bare word like "huddle" isn't a public address
  return u.origin;
}

/** Is `url` on the same site as `origin`? */
function sameOrigin(url, origin) {
  try {
    return !!origin && new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** http(s) links may be handed to the system browser; nothing else (file:, javascript:, custom schemes) ever is. */
function isSafeExternal(url) {
  try {
    const p = new URL(url).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
}

module.exports = { normalizeServerUrl, sameOrigin, isSafeExternal };
