import { Router } from "express";
import { HttpError, h, rateLimit } from "./http";

const KEY = process.env.GIPHY_API_KEY;

export const gifsRouter = Router();

/** Only GIPHY-hosted images may be attached to a message. */
export function isAllowedGif(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "giphy.com" || u.hostname.endsWith(".giphy.com"));
  } catch {
    return false;
  }
}

gifsRouter.get("/config", (_req, res) => void res.json({ gifs: !!KEY }));

async function giphy(kind: "search" | "trending", q: string, offset: number) {
  if (!KEY) throw new HttpError(501, "GIFs aren't set up on this server.");
  const url = new URL(`https://api.giphy.com/v1/gifs/${kind}`);
  url.searchParams.set("api_key", KEY);
  url.searchParams.set("limit", "24");
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("rating", "pg-13");
  if (kind === "search") url.searchParams.set("q", q);
  let json: any;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`giphy ${r.status}`);
    json = await r.json();
  } catch (e) {
    console.error("GIF lookup failed", e);
    throw new HttpError(502, "GIF search is unavailable right now.");
  }
  const gifs = (json.data ?? [])
    .map((g: any) => ({
      id: String(g.id),
      title: String(g.title ?? ""),
      url: g.images?.fixed_height?.url as string | undefined,
      preview: (g.images?.fixed_width_small?.url ?? g.images?.fixed_width?.url) as string | undefined,
      width: Number(g.images?.fixed_height?.width ?? 0),
      height: Number(g.images?.fixed_height?.height ?? 0),
    }))
    .filter((g: any) => g.url && g.preview && isAllowedGif(g.url) && isAllowedGif(g.preview));
  const total = Number(json.pagination?.total_count ?? 0);
  return { gifs, next: offset + 24 < total ? offset + 24 : null };
}

gifsRouter.get("/gifs/search", h(async (req, res) => {
  rateLimit(`gif:${req.user!.id}`, 30, 60_000);
  const q = String(req.query.q ?? "").trim().slice(0, 80);
  if (!q) throw new HttpError(400, "Type something to search for.");
  res.json(await giphy("search", q, Math.max(0, Number(req.query.offset) || 0)));
}));

gifsRouter.get("/gifs/trending", h(async (req, res) => {
  rateLimit(`gif:${req.user!.id}`, 30, 60_000);
  res.json(await giphy("trending", "", Math.max(0, Number(req.query.offset) || 0)));
}));
