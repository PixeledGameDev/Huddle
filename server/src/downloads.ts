import fs from "fs";
import path from "path";
import { Router, type Request, type Response } from "express";
import { h, HttpError } from "./http";
import { getObject, r2Enabled, toNodeStream } from "./storage";

/**
 * Desktop app downloads, served from this site so the code repository can stay private.
 *
 * The installers are built by the "Desktop app" GitHub workflow, which uploads them to the R2 bucket under
 * "desktop/" together with a small manifest, "desktop/latest.json". This file only reads that: it lists what's
 * available (GET /api/desktop), shows a download page (GET /download), and hands out the files
 * (GET /download/<file name>). Only files named in the manifest can be fetched, and downloads need no sign-in
 * (the app is useless without an account on this server).
 *
 * Without R2 (local development) the same files are read from the folder DOWNLOADS_DIR (default ./downloads).
 */
export const downloadsRouter = Router();

export interface DesktopFile {
  platform: "windows" | "mac" | "linux";
  arch: "x64" | "arm64";
  kind: "exe" | "dmg" | "AppImage" | "deb";
  name: string;
  size: number;
  sha256: string;
}
export interface DesktopManifest {
  version: string;
  builtAt: string;
  files: DesktopFile[];
}

const dir = process.env.DOWNLOADS_DIR ?? path.join(__dirname, "../../downloads");
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const PLATFORMS = ["windows", "mac", "linux"];
const ARCHES = ["x64", "arm64"];
const KINDS = ["exe", "dmg", "AppImage", "deb"];

/** Accepts only a well-formed manifest; anything unexpected in it is dropped rather than trusted. */
export function parseManifest(raw: unknown): DesktopManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.version !== "string" || !/^[0-9A-Za-z.+-]{1,40}$/.test(m.version) || !Array.isArray(m.files)) return null;
  const files: DesktopFile[] = [];
  for (const f of m.files) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    if (
      PLATFORMS.includes(x.platform as string) && ARCHES.includes(x.arch as string) && KINDS.includes(x.kind as string) &&
      typeof x.name === "string" && SAFE_NAME.test(x.name) &&
      typeof x.size === "number" && Number.isFinite(x.size) && x.size > 0 &&
      typeof x.sha256 === "string" && /^[0-9a-f]{64}$/.test(x.sha256)
    )
      files.push({ platform: x.platform as DesktopFile["platform"], arch: x.arch as DesktopFile["arch"], kind: x.kind as DesktopFile["kind"], name: x.name, size: x.size, sha256: x.sha256 });
  }
  return files.length ? { version: m.version, builtAt: typeof m.builtAt === "string" ? m.builtAt.slice(0, 40) : "", files } : null;
}

let cached: { at: number; manifest: DesktopManifest | null } | null = null;
async function loadManifest(): Promise<DesktopManifest | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.manifest;
  let manifest: DesktopManifest | null = null;
  try {
    let text: string | null = null;
    if (r2Enabled) {
      const r = await getObject("desktop/latest.json");
      if (r.ok) text = await r.text();
      else await r.arrayBuffer().catch(() => {});
    } else if (fs.existsSync(path.join(dir, "latest.json"))) text = fs.readFileSync(path.join(dir, "latest.json"), "utf8");
    if (text) manifest = parseManifest(JSON.parse(text));
  } catch (e) {
    console.error("Couldn't read the desktop download manifest", e);
  }
  cached = { at: Date.now(), manifest };
  return manifest;
}

downloadsRouter.get("/api/desktop", h(async (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({ desktop: await loadManifest() });
}));

downloadsRouter.get("/download/:name", h(async (req: Request, res: Response) => {
  const manifest = await loadManifest();
  const file = manifest?.files.find((f) => f.name === req.params.name);
  if (!file) throw new HttpError(404, "That file isn't available.");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Length", String(file.size));
  if (!r2Enabled) {
    const p = path.join(dir, file.name);
    if (!fs.existsSync(p)) throw new HttpError(404, "That file isn't available.");
    return void fs.createReadStream(p).pipe(res);
  }
  const upstream = await getObject(`desktop/${file.name}`);
  if (!upstream.ok || !upstream.body) throw new HttpError(404, "That file isn't available.");
  toNodeStream(upstream.body as ReadableStream<Uint8Array>).on("error", () => res.destroy()).pipe(res);
}));

/**
 * Files the desktop app's updater reads (electron-updater, "generic" provider): latest.yml, latest-mac.yml and
 * latest-linux.yml describe the newest version, and the installers they name sit next to them. They come from the same
 * "desktop/" folder as the downloads. The app has no sign-in when it asks, so only these file types and plain names are served.
 */
const UPDATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(yml|exe|dmg|zip|AppImage|blockmap)$/;
downloadsRouter.get("/desktop-updates/:name", h(async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!UPDATE_NAME.test(name) || name.includes("..")) throw new HttpError(404, "Not found.");
  const isYml = name.endsWith(".yml");
  res.setHeader("Content-Type", isYml ? "text/yaml; charset=utf-8" : "application/octet-stream");
  res.setHeader("Cache-Control", isYml ? "no-cache" : "public, max-age=3600");
  if (!r2Enabled) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) throw new HttpError(404, "Not found.");
    res.setHeader("Content-Length", String(fs.statSync(p).size));
    return void fs.createReadStream(p).pipe(res);
  }
  const upstream = await getObject(`desktop/${name}`);
  if (!upstream.ok || !upstream.body) {
    await upstream.arrayBuffer().catch(() => {});
    throw new HttpError(404, "Not found.");
  }
  const len = upstream.headers.get("content-length");
  if (len) res.setHeader("Content-Length", len);
  toNodeStream(upstream.body as ReadableStream<Uint8Array>).on("error", () => res.destroy()).pipe(res);
}));

// ---------- the download page (plain HTML, no scripts) ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const mb = (n: number) => `${Math.max(1, Math.round(n / 1048576))} MB`;

const LABEL: Record<string, string> = { exe: "Installer (.exe)", dmg: "Disk image (.dmg)", AppImage: "AppImage", deb: "Debian/Ubuntu (.deb)" };
const SECTIONS: { platform: DesktopFile["platform"]; title: string; note?: string }[] = [
  { platform: "windows", title: "Windows", note: "Windows 10 or newer. If Windows warns about an unknown publisher, choose More info, then Run anyway." },
  { platform: "mac", title: "macOS", note: "Choose Apple silicon for Macs with an M-series chip (Apple menu → About This Mac shows the chip), otherwise Intel. The first time, right-click the app and choose Open." },
  { platform: "linux", title: "Linux", note: "The AppImage runs on most systems: make it executable, then run it." },
];

export function detectPlatform(userAgent: string): DesktopFile["platform"] | "mobile" | null {
  if (/android|iphone|ipad|ipod/i.test(userAgent)) return "mobile";
  if (/windows/i.test(userAgent)) return "windows";
  if (/macintosh|mac os x/i.test(userAgent)) return "mac";
  if (/linux|x11/i.test(userAgent)) return "linux";
  return null;
}

export function renderDownloadPage(manifest: DesktopManifest | null, origin: string, userAgent: string): string {
  const mine = detectPlatform(userAgent);
  const sections = [...SECTIONS].sort((a, b) => Number(b.platform === mine) - Number(a.platform === mine));
  const body = !manifest
    ? `<p class="lead">The desktop app isn't available to download yet. Check back soon.</p>`
    : sections
        .map((s) => {
          const files = manifest.files.filter((f) => f.platform === s.platform);
          if (!files.length) return "";
          const rows = files
            .sort((a, b) => (a.arch === b.arch ? 0 : a.arch === "arm64" ? -1 : 1))
            .map((f) => {
              const arch = s.platform === "mac" ? (f.arch === "arm64" ? "Apple silicon" : "Intel") : s.platform === "linux" ? "" : "";
              const label = [LABEL[f.kind], arch].filter(Boolean).join(" · ");
              return `<li><a class="btn${s.platform === mine ? " primary" : ""}" href="/download/${encodeURIComponent(f.name)}">Download ${esc(label)}</a><span class="meta">${mb(f.size)} · <abbr title="SHA-256: ${f.sha256}">checksum</abbr></span></li>`;
            })
            .join("");
          return `<section${s.platform === mine ? ' class="mine"' : ""}><h2>${esc(s.title)}${s.platform === mine ? ' <small>(your computer)</small>' : ""}</h2><ul>${rows}</ul>${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}</section>`;
        })
        .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download Huddle</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
:root{color-scheme:light dark;--accent:#3556d8}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:620px;margin:0 auto;padding:40px 20px}
h1{margin:0 0 4px;font-size:28px} .lead{opacity:.75;margin:0 0 24px}
section{border:1px solid #8884;border-radius:12px;padding:16px 18px;margin:0 0 14px} section.mine{border-color:var(--accent)}
h2{margin:0 0 10px;font-size:18px} h2 small{font-weight:400;opacity:.65;font-size:13px}
ul{list-style:none;margin:0;padding:0;display:grid;gap:8px} li{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.btn{display:inline-block;padding:9px 14px;border-radius:8px;border:1px solid #8886;color:inherit;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.meta{opacity:.65;font-size:13px} .note{margin:10px 0 0;opacity:.75;font-size:14px} a.home{color:var(--accent)}
.steps{opacity:.85;font-size:15px} code{background:#8882;padding:1px 6px;border-radius:5px}
</style></head><body><main>
<h1>Huddle for desktop</h1>
<p class="lead">${manifest ? `Version ${esc(manifest.version)}. ` : ""}Notifications, an unread badge, and a tray icon, in their own window.</p>
${mine === "mobile" ? `<p class="note">The desktop app is for Windows computers. On a phone, use Huddle in your browser.</p>` : ""}
${body}
<p class="steps">After installing, open Huddle and sign in. If it asks for a server address, enter <code>${esc(origin)}</code>.</p>
<p><a class="home" href="/">Back to Huddle</a></p>
</main></body></html>`;
}

downloadsRouter.get("/download", h(async (req: Request, res: Response) => {
  const origin = `${req.protocol}://${req.get("host")}`;
  res.setHeader("Cache-Control", "no-cache");
  res.type("html").send(renderDownloadPage(await loadManifest(), origin, req.get("user-agent") ?? ""));
}));
