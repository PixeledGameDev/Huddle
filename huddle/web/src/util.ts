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
