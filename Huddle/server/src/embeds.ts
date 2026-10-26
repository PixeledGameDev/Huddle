import crypto from "crypto";
import dns from "dns";
import http from "http";
import https from "https";
import net from "net";
import zlib from "zlib";
import type { Readable } from "stream";
import { Router } from "express";
import { sniffImage } from "./fileutil";
import { HttpError, h, rateLimit } from "./http";

/**
 * Link previews. The browser never contacts the linked site: members ask this server for a preview, the server
 * fetches the page, reads its title/description/image tags, and sends back only that. Preview images are fetched and
 * re-served by this server too (the CSP only allows images from here), so a link can't be used to see anyone's IP.
 *
 * Because the server is the one making requests on a stranger's behalf, everything here is built around not being
 * talked into reaching things it shouldn't (see "Fetching safely" below).
 */
export const embedsRouter = Router();

export interface Embed {
  url: string;
  host: string;
  /** "link": has a title, description, or image. "image": the link is itself a picture. "minimal": nothing could be read. */
  kind: "link" | "image" | "minimal";
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  large: boolean;
}

const MAX_HTML_BYTES = 600_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 6000;
const MAX_URL_LENGTH = 2048;

// ---------- Fetching safely ----------
// 1. Only http(s) on the default ports, no credentials in the URL.
// 2. The address actually connected to is checked, not just the hostname: DNS answers are validated inside the
//    socket's own lookup (so a name can't resolve to something different between "check" and "connect"), and a name
//    that resolves to even one private address is refused. IP-literal hosts never go through lookup, so they're checked up front.
// 3. Redirects are followed by hand, and every hop gets the same checks again.
// 4. Hard caps on time, size (counted after decompression), and redirects.

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(addr, prefix, "ipv6");
// (IPv4-mapped IPv6 addresses such as ::ffff:127.0.0.1 are matched by the IPv4 rules above.)

const isBlockedIp = (ip: string) => {
  const family = net.isIP(ip);
  return family === 0 || blocked.check(ip, family === 6 ? "ipv6" : "ipv4");
};

function assertPublicUrl(u: URL) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("unsupported scheme");
  if (u.username || u.password) throw new Error("credentials in URL");
  if (u.port && u.port !== "80" && u.port !== "443") throw new Error("unsupported port");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("local host");
  if (net.isIP(host) && isBlockedIp(host)) throw new Error("blocked address");
}

const publicLookup = ((hostname: string, options: any, cb: any) => {
  const opts = typeof options === "object" && options ? options : {};
  dns.lookup(hostname, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as unknown as dns.LookupAddress[];
    if (!list.length || list.some((a) => isBlockedIp(a.address))) return cb(new Error("blocked address"));
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  });
}) as net.LookupFunction;

interface Fetched {
  url: URL; // where the redirects ended up
  status: number;
  type: string; // content-type without parameters, lowercase
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  skipped: boolean; // the body wasn't wanted, so it wasn't downloaded
}

async function fetchPublic(start: URL, o: { maxBytes: number; accept: string; wantBody: (type: string) => boolean }): Promise<Fetched> {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  const left = () => Math.max(1, deadline - Date.now());
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicUrl(url);
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.request(
        url,
        {
          method: "GET",
          agent: false,
          lookup: publicLookup,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; HuddleBot/1.0; link preview)",
            Accept: o.accept,
            "Accept-Language": "en",
            "Accept-Encoding": "gzip, deflate, br",
          },
        },
        resolve
      );
      req.setTimeout(left(), () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });

    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.destroy();
      url = new URL(location, url);
      continue;
    }

    const type = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const base = { url, status, type, headers: res.headers };
    if (!o.wantBody(type)) {
      res.destroy();
      return { ...base, body: Buffer.alloc(0), truncated: false, skipped: true };
    }
    const declared = Number(res.headers["content-length"]);
    if (declared > o.maxBytes && !/^text\/html|xhtml/.test(type)) {
      res.destroy();
      return { ...base, body: Buffer.alloc(0), truncated: true, skipped: false };
    }

    const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
    let stream: Readable = res;
    if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
    else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
    else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
    else if (encoding && encoding !== "identity") {
      res.destroy();
      throw new Error("unsupported encoding");
    }

    return await new Promise<Fetched>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      const timer = setTimeout(() => fail(new Error("timeout")), left());
      const end = (truncated: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.destroy();
        stream.destroy();
        resolve({ ...base, body: Buffer.concat(chunks), truncated, skipped: false });
      };
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res.destroy();
        stream.destroy();
        reject(e);
      };
      stream.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) {
          chunks.push(c.subarray(0, c.length - (size - o.maxBytes)));
          end(true);
        } else chunks.push(c);
      });
      stream.on("end", () => end(false));
      stream.on("error", fail);
      res.on("error", fail);
    });
  }
  throw new Error("too many redirects");
}

/** At most this many outbound fetches run at once; the rest wait their turn. */
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 8) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// ---------- Reading the page ----------
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", eacute: "é",
};
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}
const clean = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();
const clip = (s: string | null | undefined, n: number) => (s ? (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s) : null);

function parseAttrs(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

function decodeBody(body: Buffer, contentType: string): string {
  const label =
    /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString("latin1"))?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

function readPage(html: string, finalUrl: URL) {
  const end = html.search(/<\/head\s*>|<body[\s>]/i);
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 200_000);
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const a = parseAttrs(m[1]);
    const key = (a.get("property") ?? a.get("name") ?? "").toLowerCase();
    const value = a.get("content");
    if (key && value && !meta.has(key)) meta.set(key, clean(value));
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];
  const pick = (...keys: string[]) => keys.map((k) => meta.get(k)).find((v) => !!v) || null;

  let image: string | null = null;
  const rawImage = pick("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src");
  if (rawImage) {
    try {
      const u = new URL(rawImage, finalUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.href.length <= MAX_URL_LENGTH) image = u.href;
    } catch {
      /* not a usable URL */
    }
  }
  const imageWidth = Number(meta.get("og:image:width"));
  return {
    siteName: clip(pick("og:site_name", "application-name"), 80),
    title: clip(pick("og:title", "twitter:title") ?? (titleTag ? clean(titleTag) : null), 200),
    description: clip(pick("og:description", "twitter:description", "description"), 300),
    image,
    large: meta.get("twitter:card") !== "summary" && !(imageWidth > 0 && imageWidth < 300),
  };
}

// ---------- Preview images are served by us, and only the ones we handed out ----------
const SIGNING_KEY = process.env.EMBED_SECRET ? Buffer.from(process.env.EMBED_SECRET) : crypto.randomBytes(32);
const sign = (u: string) => crypto.createHmac("sha256", SIGNING_KEY).update(u).digest("base64url");
const signedImageUrl = (u: string) => `/api/embed/image?u=${encodeURIComponent(u)}&s=${sign(u)}`;
function validSignature(u: string, s: string) {
  const a = Buffer.from(sign(u));
  const b = Buffer.from(s);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp)$/;
const isHtml = (type: string) => type === "text/html" || type === "application/xhtml+xml";

const minimal = (u: URL): Embed => ({
  url: u.href,
  host: u.hostname.replace(/^www\./, ""),
  kind: "minimal",
  siteName: null,
  title: null,
  description: null,
  image: null,
  large: false,
});

/** Never throws: anything that goes wrong becomes a minimal card. */
async function unfurl(u: URL): Promise<Embed> {
  const fallback = minimal(u);
  try {
    const f = await withSlot(() =>
      fetchPublic(u, {
        maxBytes: MAX_HTML_BYTES,
        accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
        wantBody: isHtml,
      })
    );
    if (f.status < 200 || f.status >= 400) return fallback;
    if (IMAGE_TYPE.test(f.type)) return { ...fallback, kind: "image", image: signedImageUrl(f.url.href), large: true };
    if (!isHtml(f.type) || f.skipped) return fallback;
    const page = readPage(decodeBody(f.body, String(f.headers["content-type"] ?? "")), f.url);
    if (!page.title && !page.description && !page.image) return fallback;
    return { ...fallback, kind: "link", ...page, image: page.image ? signedImageUrl(page.image) : null };
  } catch {
    return fallback;
  }
}

const cache = new Map<string, { at: number; ttl: number; embed: Embed }>();
const inflight = new Map<string, Promise<Embed>>();
function getEmbed(u: URL): Promise<Embed> {
  u.hash = "";
  const key = u.href;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.embed);
  let p = inflight.get(key);
  if (!p) {
    p = unfurl(u)
      .then((embed) => {
        // Failures are remembered for less time, so a site that was briefly down isn't stuck without a card.
        cache.set(key, { at: Date.now(), ttl: embed.kind === "minimal" ? 5 * 60_000 : 30 * 60_000, embed });
        if (cache.size > 1000) cache.delete(cache.keys().next().value!);
        return embed;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

embedsRouter.get("/embed", h(async (req, res) => {
  rateLimit(`embed:${req.user!.id}`, 240, 60_000);
  const raw = String(req.query.url ?? "");
  let u: URL | null = null;
  try {
    u = raw.length <= MAX_URL_LENGTH ? new URL(raw) : null;
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) throw new HttpError(400, "That isn't a link.");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.json({ embed: await getEmbed(u) });
}));

// Small images are kept for a while so a link posted in a busy channel isn't fetched once per viewer.
const imageCache = new Map<string, { at: number; mime: string; body: Buffer }>();
let imageCacheBytes = 0;
const IMAGE_CACHE_BYTES = 32 * 1024 * 1024;
const IMAGE_CACHE_ITEM_BYTES = 1.5 * 1024 * 1024;
function rememberImage(key: string, mime: string, body: Buffer) {
  if (body.length > IMAGE_CACHE_ITEM_BYTES) return;
  imageCache.set(key, { at: Date.now(), mime, body });
  imageCacheBytes += body.length;
  for (const [k, v] of imageCache) {
    if (imageCacheBytes <= IMAGE_CACHE_BYTES && Date.now() - v.at < 30 * 60_000) break;
    imageCache.delete(k);
    imageCacheBytes -= v.body.length;
  }
}

embedsRouter.get("/embed/image", h(async (req, res) => {
  rateLimit(`embedimg:${req.user!.id}`, 300, 60_000);
  const u = String(req.query.u ?? "");
  const s = String(req.query.s ?? "");
  if (u.length > MAX_URL_LENGTH || !validSignature(u, s)) throw new HttpError(404, "No image.");

  let mime: string | null;
  let body: Buffer;
  const cached = imageCache.get(u);
  if (cached && Date.now() - cached.at < 30 * 60_000) {
    ({ mime, body } = cached);
  } else {
    let f: Fetched;
    try {
      f = await withSlot(() => fetchPublic(new URL(u), { maxBytes: MAX_IMAGE_BYTES, accept: "image/*", wantBody: (t) => t.startsWith("image/") }));
    } catch {
      throw new HttpError(404, "No image.");
    }
    // The bytes decide what it is, not the server's say-so: only real PNG/JPEG/GIF/WebP images are passed on.
    mime = f.status >= 200 && f.status < 300 && !f.truncated && !f.skipped ? sniffImage(f.body) : null;
    body = f.body;
    if (!mime) throw new HttpError(404, "No image.");
    rememberImage(u, mime, body);
  }
  res.setHeader("Content-Type", mime!);
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.end(body);
}));
