/**
 * Away from the computer: after a set time with no keyboard or mouse use (or while the screen is locked or the computer
 * sleeps) Huddle tells the server you're idle, and tells it again when you're back. The person's own choice of status
 * (Online, Do not disturb...) is never changed by this; the server only shows "Idle" when you're otherwise Online.
 *
 * Everything the system provides is passed in, so this can be tested without Electron.
 */
const MINUTE_CHOICES = [5, 10, 15, 30, 60];
const DEFAULT_MINUTES = 10;

function sanitizeIdleSettings(v, current = { enabled: true, minutes: DEFAULT_MINUTES }) {
  return {
    enabled: typeof v?.enabled === "boolean" ? v.enabled : current.enabled,
    minutes: MINUTE_CHOICES.includes(v?.minutes) ? v.minutes : MINUTE_CHOICES.includes(current.minutes) ? current.minutes : DEFAULT_MINUTES,
  };
}

function createIdleTracker({ getIdleSeconds, onChange = () => {}, enabled = true, minutes = DEFAULT_MINUTES }) {
  let on = enabled;
  let thresholdMs = minutes * 60_000;
  let locked = false; // the screen is locked or the computer is asleep
  let idle = false;

  /** Looks at the situation now and reports if it changed. Called by the timer and by every event. */
  function check() {
    let next = false;
    if (on) {
      let secs = 0;
      try { secs = Number(getIdleSeconds()) || 0; } catch { /* the system couldn't say: count as active */ }
      next = locked || secs * 1000 >= thresholdMs;
    }
    if (next !== idle) {
      idle = next;
      onChange(idle);
    }
  }

  return {
    check,
    isIdle: () => idle,
    setLocked(v) {
      locked = !!v;
      check();
    },
    configure({ enabled: e = on, minutes: m } = {}) {
      on = !!e;
      if (MINUTE_CHOICES.includes(m)) thresholdMs = m * 60_000;
      check();
    },
  };
}

module.exports = { createIdleTracker, sanitizeIdleSettings, MINUTE_CHOICES, DEFAULT_MINUTES };
