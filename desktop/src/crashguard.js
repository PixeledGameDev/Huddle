/**
 * When Huddle's page crashes the app reloads it. That should fix a one-off crash, but a page that crashes again and again
 * must not be reloaded forever: after `max` crashes within `windowMs` it stops and lets the person know.
 */
function createCrashGuard({ max = 3, windowMs = 5 * 60_000, now = Date.now } = {}) {
  let times = [];
  return {
    /** Records a crash. Returns true if reloading is still fine, false once there have been too many. */
    allowReload() {
      const t = now();
      times = times.filter((x) => t - x < windowMs);
      times.push(t);
      return times.length <= max;
    },
  };
}

/** Which ways the page's process can end are worth a reload ("clean-exit" is a normal shutdown). */
const shouldReload = (reason) => reason !== "clean-exit";

module.exports = { createCrashGuard, shouldReload };
