/** Identify safe raster images by magic bytes. Anything else is treated as an opaque download. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const head = b.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export const cleanName = (s: string) => s.replace(/[\\\/\u0000-\u001f"<>:*?|]+/g, "_").trim().slice(0, 120) || "file";

export const channelSlug = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Identify videos browsers can play (MP4/M4V/MOV and WebM) by magic bytes, like sniffImage does for pictures.
 * The file's own claim about what it is (name, content type) is never trusted.
 */
export function sniffVideo(b: Buffer): string | null {
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = b.subarray(8, 12).toString("latin1");
    if (brand === "qt  ") return "video/quicktime";
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V[ HP]|dash|mmp4|f4v )$/.test(brand)) return "video/mp4";
    return null; // other ftyp files are pictures (heic), audio (M4A), 3GP and so on
  }
  if (b.length >= 32 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && b.subarray(0, 64).toString("latin1").includes("webm")) return "video/webm";
  return null;
}

/**
 * Reads an HTTP Range header ("bytes=0-1023", "bytes=500-", "bytes=-500") for a file of `size` bytes. Returns the
 * inclusive byte range, null when there's no (usable) range so the whole file should be sent, or "invalid" when the
 * range lies outside the file (answer 416). Only a single range is supported, which is all media players ask for.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]); // the last N bytes
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return "invalid";
  return { start, end };
}
