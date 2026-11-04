const test = require("node:test");
const assert = require("node:assert");
const { createCrashGuard, shouldReload } = require("../src/crashguard");

test("a few crashes are reloaded, a crash loop is not", () => {
  let t = 0;
  const g = createCrashGuard({ max: 3, windowMs: 5 * 60_000, now: () => t });
  assert.deepStrictEqual([g.allowReload(), g.allowReload(), g.allowReload(), g.allowReload()], [true, true, true, false]);
});
test("crashes spread out over time never add up to a loop", () => {
  let t = 0;
  const g = createCrashGuard({ max: 3, windowMs: 5 * 60_000, now: () => t });
  for (let i = 0; i < 10; i++) {
    t += 6 * 60_000;
    assert.strictEqual(g.allowReload(), true);
  }
});
test("after a quiet spell it is allowed again", () => {
  let t = 0;
  const g = createCrashGuard({ max: 2, windowMs: 60_000, now: () => t });
  g.allowReload(); g.allowReload();
  assert.strictEqual(g.allowReload(), false);
  t += 61_000;
  assert.strictEqual(g.allowReload(), true);
});
test("only a normal shutdown is left alone", () => {
  assert.strictEqual(shouldReload("clean-exit"), false);
  for (const r of ["crashed", "oom", "abnormal-exit", "killed", "launch-failed", "integrity-failure"]) assert.strictEqual(shouldReload(r), true, r);
});
