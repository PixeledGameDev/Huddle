import type { Request, Response } from "express";
import { pipeline } from "stream";
import { HttpError } from "./http";
import { parseRange } from "./fileutil";
import { getObject, r2Enabled, toNodeStream } from "./storage";

export interface StoredFile {
  name: string;
  mime: string;
  size: number;
  data: Buffer | null;
  storage_key: string | null;
}

/**
 * Sends an attachment. Pictures and videos are shown in the page ("inline"); everything else downloads. Byte ranges are
 * supported because video players need them to start quickly and to seek (Safari won't play video without them).
 * Permission checks happen before this is called.
 */
export async function serveFile(req: Request, res: Response, f: StoredFile) {
  const inline = f.mime.startsWith("image/") || f.mime.startsWith("video/");
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_");
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");

  const range = parseRange(req.headers.range, f.size);
  if (range === "invalid") {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${f.size}`);
    return void res.end();
  }

  if (f.storage_key) {
    if (!r2Enabled) throw new HttpError(503, "File storage isn't configured on this server.");
    const upstream = await getObject(f.storage_key, range ? { Range: `bytes=${range.start}-${range.end}` } : undefined);
    if (!upstream.ok || !upstream.body) {
      console.error(`R2 download failed for ${f.storage_key}: ${upstream.status}`);
      throw new HttpError(upstream.status === 404 ? 404 : 502, "That file can't be loaded right now.");
    }
    // If storage ignored the range and sent everything, so do we (a 200 is always a valid answer to a range request).
    if (range && upstream.status === 206) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${f.size}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else res.setHeader("Content-Length", String(f.size));
    pipeline(toNodeStream(upstream.body as ReadableStream<Uint8Array>), res, (err) => {
      if (err) res.destroy(); // for example, the viewer skipped ahead in a video and the old request was abandoned
    });
    return;
  }

  if (!f.data) throw new HttpError(404, "File not found.");
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${f.size}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
    return void res.end(f.data.subarray(range.start, range.end + 1));
  }
  res.setHeader("Content-Length", String(f.size));
  res.end(f.data);
}
