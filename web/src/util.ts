import type { Vote, VoteAction } from "./types";

export function fmtDuration(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hr`;
  const d = Math.round(seconds / 86400);
  return `${d} ${d === 1 ? "day" : "days"}`;
}

export const actionVerb = (a: VoteAction) => (a === "kick" ? "kick" : a === "timeout" ? "time out" : "ban");

export function actionPhrase(v: Pick<Vote, "action" | "durationSeconds">) {
  return v.action === "kick" ? "kick" : `${actionVerb(v.action)} for ${fmtDuration(v.durationSeconds)}`;
}

export function hue(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const dateTimeOf = (iso: string) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtRemaining(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

export const nameOfUser = (u: { displayName?: string | null; username: string }) => u.displayName || u.username;

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Videos can be bigger. (The server decides by the file's contents and may allow less if it keeps files in its database.) */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
export const looksLikeVideo = (f: { type: string; name: string }) => f.type.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/i.test(f.name);
export const MAX_ATTACHMENTS = 4;

export const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: "Smileys", emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "😊", "😇", "🙂", "😉", "😍", "🥰", "😘", "😋", "😛", "😜", "🤪", "🤔", "🤨", "😐", "🙄", "😏", "😒", "😞", "😔", "😕", "🙁", "😖", "😩", "🥺", "😢", "😭", "😤", "😠", "😡", "🤯", "😳", "🥵", "🥶", "😱", "😨", "😰", "🤗", "🤫", "🥱", "😴", "😎", "🤓", "🥳"] },
  { label: "Gestures", emojis: ["👍", "👎", "👌", "✌️", "🤞", "🤟", "🤘", "👏", "🙌", "🙏", "💪", "👋", "🤝", "✋", "👀"] },
  { label: "Symbols", emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💯", "🔥", "✨", "⭐", "🎉", "🎊", "🏆", "✅", "❌", "⚠️", "❓", "❗", "💡"] },
  { label: "Things", emojis: ["🎮", "🎧", "🎵", "📷", "💻", "📱", "☕", "🍕", "🍔", "🍟", "🍺", "🎂", "🌈", "☀️", "🌙", "⚡", "🐶", "🐱", "🐸", "🦄"] },
];

/** Center-crop an image to a square and downscale it, so avatars and icons stay small. */
export async function squareImage(file: File, size = 256): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const s = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't process that image."))), "image/webp", 0.9));
}

/** A wide 3:1 crop for profile banners. */
export async function bannerImage(file: File, width = 900): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const height = Math.round(width / 3);
  const scale = Math.max(width / bmp.width, height / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bmp, (width - w) / 2, (height - h) / 2, w, h);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't process that image."))), "image/webp", 0.88));
}

/** Invite links look like https://<this app>/invite/<code>. */
export const INVITE_URL_RE = /https?:\/\/[^\s/]+\/invite\/([A-Za-z0-9_-]{6,32})(?![A-Za-z0-9_-])/g;

export function isOwnInviteUrl(url: string, host = typeof window !== "undefined" ? window.location.host : "") {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/** Distinct invite codes for links in a message that point at this app (at most 3). */
export function inviteCodesIn(text: string): string[] {
  const codes: string[] = [];
  for (const m of text.matchAll(new RegExp(INVITE_URL_RE))) {
    if (isOwnInviteUrl(m[0]) && !codes.includes(m[1])) codes.push(m[1]);
  }
  return codes.slice(0, 3);
}

/** Accepts a pasted invite link or a bare code. */
export function extractInviteCode(input: string): string {
  const t = input.trim();
  return /\/invite\/([A-Za-z0-9_-]{6,32})/.exec(t)?.[1] ?? t;
}
