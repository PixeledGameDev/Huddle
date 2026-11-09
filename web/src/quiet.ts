/**
 * Quiet hours: a daily window (for example 22:00 to 07:00) when Huddle stays silent: no popups, sounds or flashing, while
 * unread counts and badges keep updating. The same rule lives in the desktop app (desktop-rs/src/quiet.rs): keep the two in step.
 */
export interface QuietHours {
  enabled: boolean;
  from: string; // "HH:MM", 24-hour
  to: string;
}
export const DEFAULT_QUIET: QuietHours = { enabled: false, from: "22:00", to: "07:00" };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The schedule in its safe shape, whatever was saved. */
export function sanitizeQuiet(q: unknown): QuietHours {
  const v = (q && typeof q === "object" ? q : {}) as Partial<Record<keyof QuietHours, unknown>>;
  const time = (t: unknown, fallback: string) => (typeof t === "string" && TIME.test(t) ? t : fallback);
  return { enabled: v.enabled === true, from: time(v.from, DEFAULT_QUIET.from), to: time(v.to, DEFAULT_QUIET.to) };
}

const minutesOf = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Is it quiet at `date` (local time)? A window that ends before it starts runs overnight; equal times mean no window. */
export function isQuiet(q: unknown, date = new Date()): boolean {
  const s = sanitizeQuiet(q);
  if (!s.enabled) return false;
  const from = minutesOf(s.from);
  const to = minutesOf(s.to);
  if (from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}
