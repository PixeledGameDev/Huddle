import type { Vote, VoteAction } from "./types";

export function fmtDuration(seconds: number) {
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const h = Math.round(seconds / 3600);
    return `${h} hr`;
  }
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

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS = 4;
export const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👀", "🙏", "✅", "❌", "💯", "🤔", "😎", "👏", "😡"];
