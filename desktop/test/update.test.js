const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { updateFeedUrl, canAutoUpdate, isNewerVersion, createUpdater } = require("../src/update");

test("the update feed lives on the server", () => {
  assert.strictEqual(updateFeedUrl("https://huddle.example.com"), "https://huddle.example.com/desktop-updates");
  assert.strictEqual(updateFeedUrl("https://huddle.example.com/"), "https://huddle.example.com/desktop-updates");
  assert.strictEqual(updateFeedUrl(null), null);
});

test("only installed apps update themselves", () => {
  assert.ok(canAutoUpdate({ isPackaged: true, platform: "win32", env: {} }));
  assert.ok(canAutoUpdate({ isPackaged: true, platform: "darwin", env: {} }));
  assert.ok(!canAutoUpdate({ isPackaged: false, platform: "win32", env: {} }), "npm start never updates");
  assert.ok(!canAutoUpdate({ isPackaged: true, platform: "linux", env: {} }), "a .deb can't update itself");
  assert.ok(canAutoUpdate({ isPackaged: true, platform: "linux", env: { APPIMAGE: "/x/Huddle.AppImage" } }));
  assert.ok(!canAutoUpdate({ isPackaged: true, platform: "win32", env: { HUDDLE_NO_AUTO_UPDATE: "1" } }));
});

test("version comparison", () => {
  assert.ok(isNewerVersion("1.2.0", "1.1.9"));
  assert.ok(isNewerVersion("2.0.0", "1.9.9"));
  assert.ok(!isNewerVersion("1.1.0", "1.1.0"));
  assert.ok(!isNewerVersion("1.0.9", "1.1.0"));
  assert.ok(!isNewerVersion("garbage", "1.1.0"));
});

/** A stand-in for electron-updater that scripts what happens on checkForUpdates(). */
function fakeUpdater(script) {
  const u = new EventEmitter();
  u.feed = null;
  u.setFeedURL = (f) => { u.feed = f; };
  u.checkForUpdates = async () => { await script(u); };
  u.quitAndInstall = () => { u.installed = true; };
  return u;
}

test("checks use the generic feed and settle on 'up to date'", async () => {
  const au = fakeUpdater(async (u) => { u.emit("checking-for-update"); u.emit("update-not-available", {}); });
  const states = [];
  const up = createUpdater({ autoUpdater: au, onState: (s) => states.push(s.status) });
  const s = await up.check("https://h.example.com/desktop-updates");
  assert.deepStrictEqual(au.feed, { provider: "generic", url: "https://h.example.com/desktop-updates" });
  assert.strictEqual(s.status, "idle");
  assert.ok(s.upToDate);
  assert.deepStrictEqual(states, ["checking", "idle"]);
  assert.strictEqual(au.disableDifferentialDownload, true);
});

test("an update downloads and becomes ready, and can be installed", async () => {
  const au = fakeUpdater(async (u) => {
    u.emit("checking-for-update");
    u.emit("update-available", { version: "1.2.0" });
    u.emit("download-progress", { percent: 41.6 });
    u.emit("update-downloaded", { version: "1.2.0" });
  });
  const up = createUpdater({ autoUpdater: au });
  const s = await up.check("https://h.example.com/desktop-updates");
  assert.deepStrictEqual(s, { status: "ready", version: "1.2.0" });
  up.installNow();
  assert.ok(au.installed);
  // while one is waiting, further checks do nothing
  au.setFeedURL = () => assert.fail("must not check again");
  assert.strictEqual((await up.check("https://h.example.com/desktop-updates")).status, "ready");
});

test("errors are reported, not thrown", async () => {
  const au = fakeUpdater(async () => { throw new Error("ECONNREFUSED"); });
  const up = createUpdater({ autoUpdater: au });
  const s = await up.check("https://h.example.com/desktop-updates");
  assert.strictEqual(s.status, "error");
  assert.match(s.message, /ECONNREFUSED/);
});

test("startup: no update means carry on", async () => {
  const au = fakeUpdater(async (u) => { u.emit("checking-for-update"); u.emit("update-not-available", {}); });
  const up = createUpdater({ autoUpdater: au });
  assert.strictEqual(await up.startupCheck("https://h/desktop-updates"), "none");
});

test("startup: an update is downloaded (with progress) and reported ready", async () => {
  const au = fakeUpdater(async (u) => {
    u.emit("checking-for-update");
    u.emit("update-available", { version: "2.0.0" });
    await new Promise((r) => setTimeout(r, 10));
    u.emit("download-progress", { percent: 50 });
    await new Promise((r) => setTimeout(r, 10));
    u.emit("update-downloaded", { version: "2.0.0" });
  });
  const up = createUpdater({ autoUpdater: au });
  const seen = [];
  const result = await up.startupCheck("https://h/desktop-updates", { onProgress: (s) => seen.push(s.percent) });
  assert.strictEqual(result, "ready");
  assert.ok(seen.includes(0) && seen.includes(50));
});

test("startup: a server that never answers doesn't block the app", async () => {
  const au = fakeUpdater(() => new Promise(() => {}));
  const up = createUpdater({ autoUpdater: au });
  const t = Date.now();
  assert.strictEqual(await up.startupCheck("https://h/desktop-updates", { findTimeoutMs: 80 }), "none");
  assert.ok(Date.now() - t < 1500);
});

test("startup: a failing server doesn't block the app", async () => {
  const au = fakeUpdater(async () => { throw new Error("404"); });
  const up = createUpdater({ autoUpdater: au });
  assert.strictEqual(await up.startupCheck("https://h/desktop-updates"), "none");
});
