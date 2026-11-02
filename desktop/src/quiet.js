/**
 * Quiet hours: a daily window (for example 22:00 to 07:00) when Huddle stays silent. No popups, no sounds and no
 * taskbar flashing; unread counts and badges still update, so nothing is lost.
 * The same rule lives in the website's notify code (web/src/quiet.ts): keep the two in step.
 */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Returns the schedule in its safe shape, whatever was passed in. */
function sanitizeQuiet(q) {
  const ok = (t, fallback) => (typeof t === "string" && TIME.test(t) ? t : fallback);
  return { enabled: q?.enabled === true, from: ok(q?.from, "22:00"), to: ok(q?.to, "07:00") };
}

const minutesOf = (t) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Is it quiet at `date` (local time)? A window that ends before it starts runs overnight; equal times mean no window. */
function isQuiet(q, date = new Date()) {
  const s = sanitizeQuiet(q);
  if (!s.enabled) return false;
  const from = minutesOf(s.from);
  const to = minutesOf(s.to);
  if (from === to) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  return from < to ? now >= from && now < to : now >= from || now < to;
}

module.exports = { sanitizeQuiet, isQuiet };
