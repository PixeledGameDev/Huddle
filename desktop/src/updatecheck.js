/**
 * When to look for updates, and when to tell the person one is waiting.
 *
 * The scheduler checks regularly, soon after something that suggests the computer was away (waking, unlocking, opening
 * the window), and tries again sooner after a failure, which is common when a free server is still waking up.
 * The notifier shows "update ready" once per version, reminds again after a day if it's ignored, and waits out quiet hours.
 *
 * Timers, the clock and what to do are all passed in, so this can be tested without waiting.
 */

function createUpdateScheduler({
  check, // async () => state: looks for an update
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  intervalMs = 45 * 60_000, // between checks when all is well
  firstCheckMs = 2 * 60_000, // the first check after the app starts (the start-up check may have failed while a server woke up)
  retryMs = 5 * 60_000, // after a failure, doubling each time...
  retryMaxMs = 60 * 60_000, // ...up to this
  minGapMs = 10 * 60_000, // an event ("poke") never causes a check sooner than this after the last one
}) {
  let timer = null;
  let lastCheckAt = -Infinity;
  let failures = 0;
  let stopped = true;
  let running = false;

  const arm = (ms) => {
    clearTimer(timer);
    if (!stopped) timer = setTimer(run, ms);
    if (timer && typeof timer.unref === "function") timer.unref();
  };

  async function run() {
    if (stopped || running) return;
    running = true;
    lastCheckAt = now();
    let state;
    try {
      state = await check();
    } catch {
      state = { status: "error" };
    }
    running = false;
    if (state?.status === "error") {
      failures += 1;
      arm(Math.min(retryMs * 2 ** (failures - 1), retryMaxMs));
    } else {
      failures = 0;
      arm(intervalMs);
    }
  }

  return {
    start() {
      stopped = false;
      arm(firstCheckMs);
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
    /** Something happened that suggests checking now (wake, unlock, window opened). Skipped if we checked very recently. */
    poke() {
      if (stopped || running) return false;
      if (now() - lastCheckAt < minGapMs) return false;
      void run();
      return true;
    },
    failures: () => failures,
  };
}

function createUpdateNotifier({
  show, // (version) => void: puts the popup on screen
  isQuiet = () => false,
  now = Date.now,
  remindEveryMs = 24 * 60 * 60_000,
}) {
  let shownVersion = null;
  let shownAt = 0;

  /** Called whenever the update state changes or an hour passes. Shows the popup when it's due. */
  function consider(state) {
    if (state?.status !== "ready" || !state.version) return false;
    if (isQuiet()) return false; // held back, and shown at the next look after quiet hours end
    const first = shownVersion !== state.version;
    if (!first && now() - shownAt < remindEveryMs) return false;
    shownVersion = state.version;
    shownAt = now();
    show(state.version, { reminder: !first });
    return true;
  }
  /** "Later" or dismissed: the next reminder is a full interval from now. */
  function snooze() {
    shownAt = now();
  }
  return { consider, snooze };
}

module.exports = { createUpdateScheduler, createUpdateNotifier };
