const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLogger, formatLine, redact } = require("../src/log");
const { formatDebugInfo } = require("../src/debuginfo");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "huddle-log-"));
const fixed = () => new Date("2026-10-30T09:15:02.123Z");

test("a line has the time, the level and the text", () => {
  assert.strictEqual(formatLine(fixed(), "error", ["Update failed", 3]), "2026-10-30T09:15:02.123Z ERROR Update failed 3\n");
});

test("errors are logged with their stack, indented under the line", () => {
  const e = new Error("boom");
  const line = formatLine(fixed(), "error", ["Crash:", e]);
  assert.match(line, /Crash: Error: boom\n {4}at /);
});

test("secrets, cookies and URL query strings never reach the log", () => {
  assert.strictEqual(redact("token=abc123 ok"), "token=[hidden] ok");
  assert.strictEqual(redact('{"password": "hunter2"}'), '{"password": [hidden]}');
  assert.strictEqual(redact("Authorization: Bearer abc.def-ghi"), "Authorization: [hidden]");
  assert.strictEqual(redact("GET https://x.example/api/me?token=zzz&a=1 failed"), "GET https://x.example/api/me?… failed");
  assert.strictEqual(redact("exit code: 1"), "exit code: 1"); // ordinary words stay readable
});

test("lines are written to huddle.log and read back with tail()", () => {
  const dir = tmp();
  const log = createLogger({ dir, now: fixed });
  log.info("starting");
  log.warn("hmm");
  log.error("bad", new Error("x"));
  const text = fs.readFileSync(path.join(dir, "huddle.log"), "utf8");
  assert.match(text, /INFO {2}starting/);
  assert.match(text, /WARN {2}hmm/);
  assert.strictEqual(log.tail(2).length, 2);
  assert.match(log.tail(1)[0], /ERROR bad Error: x\n {4}at /); // an entry keeps its stack together
});

test("the log rolls over when it is full and only keeps a couple of old files", () => {
  const dir = tmp();
  const log = createLogger({ dir, maxBytes: 300, keep: 2, now: fixed });
  for (let i = 0; i < 30; i++) log.info(`line number ${i} with some padding to take up room`);
  const names = fs.readdirSync(dir).sort();
  assert.deepStrictEqual(names, ["huddle.1.log", "huddle.2.log", "huddle.log"]);
  for (const n of names) assert.ok(fs.statSync(path.join(dir, n)).size <= 400);
  assert.match(log.tail(1)[0], /line number 29/); // the newest line is in the current file
});

test("an existing log keeps growing after a restart instead of starting over", () => {
  const dir = tmp();
  createLogger({ dir, now: fixed }).info("first run");
  const again = createLogger({ dir, now: fixed });
  again.info("second run");
  const text = fs.readFileSync(path.join(dir, "huddle.log"), "utf8");
  assert.ok(text.indexOf("first run") < text.indexOf("second run"));
});

test("a log that can't be written never throws", () => {
  const blocker = path.join(tmp(), "a-file");
  fs.writeFileSync(blocker, "x"); // a folder can't be made inside a file
  const log = createLogger({ dir: path.join(blocker, "logs") });
  assert.doesNotThrow(() => { log.error("one"); log.error("two"); });
  assert.deepStrictEqual(log.tail(), []);
});

test("debug info has what's needed for help and nothing private", () => {
  const text = formatDebugInfo({
    appVersion: "2.0.0", packaged: true, electron: "45.1.0", chrome: "148.0.0.0", node: "24.11.1",
    platform: "win32", arch: "x64", osVersion: "10.0.26100", serverUrl: "https://huddle.example.com/some/path?token=abc",
    uptimeSeconds: 600, update: { status: "error", message: "failed for https://huddle.example.com/x?token=abc" },
    memory: { total: 118, groups: { Page: 0, Main: 60, Other: 58 }, pageLoaded: false },
    settings: { closeToTray: true, launchAtStartup: true, startInBackground: false, unloadWhenHidden: true, lowGraphics: true },
    crashDumps: 0, logTail: ["2026-10-30T09:15:02.123Z ERROR oops"],
  });
  assert.match(text, /^Huddle desktop 2\.0\.0\n/);
  assert.match(text, /Server: huddle\.example\.com\n/);
  assert.match(text, /page unloaded/);
  assert.match(text, /Recent log:\n.*ERROR oops/);
  assert.ok(!text.includes("token=abc"));
  assert.ok(!text.includes("/some/path"));
});
