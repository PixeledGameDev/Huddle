const test = require("node:test");
const assert = require("node:assert");
const { isQuiet, sanitizeQuiet } = require("../src/quiet");
const { createIdleTracker, sanitizeIdleSettings } = require("../src/idle");
const { createUpdateScheduler, createUpdateNotifier } = require("../src/updatecheck");

const at = (h, m = 0) => new Date(2026, 9, 30, h, m);

// ---- quiet hours
test("quiet hours are off unless turned on", () => {
  assert.strictEqual(isQuiet({ enabled: false, from: "00:00", to: "23:59" }, at(12)), false);
  assert.strictEqual(isQuiet(undefined, at(12)), false);
  assert.strictEqual(isQuiet({}, at(23)), false);
});
test("a daytime window covers its start but not its end", () => {
  const q = { enabled: true, from: "09:00", to: "17:00" };
  assert.strictEqual(isQuiet(q, at(8, 59)), false);
  assert.strictEqual(isQuiet(q, at(9, 0)), true);
  assert.strictEqual(isQuiet(q, at(16, 59)), true);
  assert.strictEqual(isQuiet(q, at(17, 0)), false);
});
test("a window that ends before it starts runs overnight", () => {
  const q = { enabled: true, from: "22:00", to: "07:00" };
  assert.strictEqual(isQuiet(q, at(21, 59)), false);
  assert.strictEqual(isQuiet(q, at(22, 0)), true);
  assert.strictEqual(isQuiet(q, at(3)), true);
  assert.strictEqual(isQuiet(q, at(6, 59)), true);
  assert.strictEqual(isQuiet(q, at(7, 0)), false);
  assert.strictEqual(isQuiet(q, at(12)), false);
});
test("equal start and end means no quiet time at all", () => {
  assert.strictEqual(isQuiet({ enabled: true, from: "08:00", to: "08:00" }, at(8)), false);
});
test("bad times fall back to safe ones instead of throwing", () => {
  assert.deepStrictEqual(sanitizeQuiet({ enabled: true, from: "25:00", to: "ab" }), { enabled: true, from: "22:00", to: "07:00" });
  assert.deepStrictEqual(sanitizeQuiet({ enabled: "yes" }), { enabled: false, from: "22:00", to: "07:00" });
  assert.deepStrictEqual(sanitizeQuiet(null), { enabled: false, from: "22:00", to: "07:00" });
});

// ---- idle
function idleRig(opts = {}) {
  const r = { secs: 0, changes: [] };
  r.t = createIdleTracker({ getIdleSeconds: () => r.secs, onChange: (v) => r.changes.push(v), ...opts });
  return r;
}
test("idle after the set time without input, active again on the next keypress", () => {
  const r = idleRig({ minutes: 10 });
  r.secs = 599; r.t.check();
  assert.deepStrictEqual(r.changes, []);
  r.secs = 600; r.t.check();
  assert.deepStrictEqual(r.changes, [true]);
  r.secs = 610; r.t.check(); // still idle: no repeat report
  assert.deepStrictEqual(r.changes, [true]);
  r.secs = 2; r.t.check();
  assert.deepStrictEqual(r.changes, [true, false]);
});
test("locking the screen or sleeping is idle straight away, unlocking is not", () => {
  const r = idleRig();
  r.t.setLocked(true);
  assert.deepStrictEqual(r.changes, [true]);
  r.t.setLocked(false);
  assert.deepStrictEqual(r.changes, [true, false]);
});
test("waking up still idle stays idle until there is real activity", () => {
  const r = idleRig({ minutes: 5 });
  r.secs = 4000; r.t.setLocked(true); r.t.setLocked(false); // slept, and nobody touched anything
  assert.deepStrictEqual(r.changes, [true]);
  r.secs = 1; r.t.check();
  assert.deepStrictEqual(r.changes, [true, false]);
});
test("turning it off while idle reports active, and nothing is reported while off", () => {
  const r = idleRig({ minutes: 5 });
  r.secs = 400; r.t.check();
  r.t.configure({ enabled: false });
  assert.deepStrictEqual(r.changes, [true, false]);
  r.t.setLocked(true); r.secs = 9999; r.t.check();
  assert.deepStrictEqual(r.changes, [true, false]);
});
test("changing the time takes effect straight away", () => {
  const r = idleRig({ minutes: 30 });
  r.secs = 400; r.t.check();
  assert.deepStrictEqual(r.changes, []);
  r.t.configure({ minutes: 5 });
  assert.deepStrictEqual(r.changes, [true]);
});
test("if the system can't say how long you've been away, you count as active", () => {
  const changes = [];
  const t = createIdleTracker({ getIdleSeconds: () => { throw new Error("nope"); }, onChange: (v) => changes.push(v) });
  t.check();
  assert.deepStrictEqual(changes, []);
});
test("idle settings only accept the offered choices", () => {
  assert.deepStrictEqual(sanitizeIdleSettings({ enabled: false, minutes: 15 }), { enabled: false, minutes: 15 });
  assert.deepStrictEqual(sanitizeIdleSettings({ enabled: "x", minutes: 7 }), { enabled: true, minutes: 10 });
  assert.deepStrictEqual(sanitizeIdleSettings({ minutes: 30 }, { enabled: false, minutes: 5 }), { enabled: false, minutes: 30 });
});

// ---- update scheduler
function timerRig() {
  const r = { time: 0, timers: [], checks: 0, results: [] };
  r.now = () => r.time;
  r.setTimer = (fn, ms) => { const t = { fn, at: r.time + ms, ms }; r.timers.push(t); return t; };
  r.clearTimer = (t) => { r.timers = r.timers.filter((x) => x !== t); };
  r.check = async () => { r.checks++; return r.results.shift() ?? { status: "idle" }; };
  r.next = () => r.timers[0];
  r.fire = async () => { const t = r.timers.shift(); r.time = t.at; await t.fn(); await Promise.resolve(); };
  r.sched = (o = {}) => createUpdateScheduler({ check: r.check, now: r.now, setTimer: r.setTimer, clearTimer: r.clearTimer, ...o });
  return r;
}
test("first check soon after starting, then regularly", async () => {
  const r = timerRig(); const s = r.sched(); s.start();
  assert.strictEqual(r.next().ms, 2 * 60_000);
  await r.fire();
  assert.strictEqual(r.checks, 1);
  assert.strictEqual(r.next().ms, 45 * 60_000);
});
test("a failed check is retried sooner, doubling up to a limit, and recovery goes back to normal", async () => {
  const r = timerRig(); const s = r.sched(); s.start();
  r.results = [{ status: "error" }, { status: "error" }, { status: "error" }, { status: "error" }, { status: "error" }, { status: "error" }, { status: "idle" }];
  await r.fire(); assert.strictEqual(r.next().ms, 5 * 60_000);
  await r.fire(); assert.strictEqual(r.next().ms, 10 * 60_000);
  await r.fire(); assert.strictEqual(r.next().ms, 20 * 60_000);
  await r.fire(); assert.strictEqual(r.next().ms, 40 * 60_000);
  await r.fire(); assert.strictEqual(r.next().ms, 60 * 60_000);
  await r.fire(); assert.strictEqual(r.next().ms, 60 * 60_000);
  await r.fire(); assert.strictEqual(r.next().ms, 45 * 60_000);
  assert.strictEqual(s.failures(), 0);
});
test("waking, unlocking or opening the window checks now, but not too often", async () => {
  const r = timerRig(); const s = r.sched(); s.start();
  await r.fire(); // a check at t = 2 min
  assert.strictEqual(s.poke(), false); // too soon
  r.time += 11 * 60_000;
  assert.strictEqual(s.poke(), true);
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(r.checks, 2);
  assert.strictEqual(r.timers.length, 1); // still just one timer waiting
});
test("a check that throws counts as a failure; a stopped scheduler does nothing", async () => {
  const r = timerRig(); r.check = async () => { throw new Error("offline"); };
  const s = r.sched(); s.start();
  await r.fire();
  assert.strictEqual(s.failures(), 1);
  s.stop();
  assert.strictEqual(r.timers.length, 0);
  assert.strictEqual(s.poke(), false);
});

// ---- update notifier
test("an update is announced once, reminded after a day, and announced again for a newer one", () => {
  let t = 0; const shown = [];
  const n = createUpdateNotifier({ show: (v, o) => shown.push([v, o.reminder]), now: () => t });
  assert.strictEqual(n.consider({ status: "downloading", version: "1.9.3" }), false);
  assert.strictEqual(n.consider({ status: "ready", version: "1.9.3" }), true);
  assert.strictEqual(n.consider({ status: "ready", version: "1.9.3" }), false);
  t = 23 * 3600_000; assert.strictEqual(n.consider({ status: "ready", version: "1.9.3" }), false);
  t = 24 * 3600_000; assert.strictEqual(n.consider({ status: "ready", version: "1.9.3" }), true);
  assert.strictEqual(n.consider({ status: "ready", version: "1.9.4" }), true);
  assert.deepStrictEqual(shown, [["1.9.3", false], ["1.9.3", true], ["1.9.4", false]]);
});
test("quiet hours hold the popup back until they're over; Later pushes the reminder a day out", () => {
  let t = 0; let quiet = true; const shown = [];
  const n = createUpdateNotifier({ show: (v) => shown.push(v), isQuiet: () => quiet, now: () => t });
  assert.strictEqual(n.consider({ status: "ready", version: "2.0.0" }), false);
  quiet = false; t = 3600_000;
  assert.strictEqual(n.consider({ status: "ready", version: "2.0.0" }), true);
  n.snooze(); t += 23 * 3600_000;
  assert.strictEqual(n.consider({ status: "ready", version: "2.0.0" }), false);
  t += 2 * 3600_000;
  assert.strictEqual(n.consider({ status: "ready", version: "2.0.0" }), true);
  assert.deepStrictEqual(shown, ["2.0.0", "2.0.0"]);
});
