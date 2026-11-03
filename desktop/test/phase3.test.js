const test = require("node:test");
const assert = require("node:assert");
const { parseDeepLink, parseLaunchArgs, invitePath, jumpListTasks } = require("../src/deeplink");
const { buildContextMenu } = require("../src/contextmenu");

// ---- huddle:// links
test("an invite link gives its code", () => {
  assert.deepStrictEqual(parseDeepLink("huddle://invite/AbC123xy"), { type: "invite", code: "AbC123xy" });
  assert.deepStrictEqual(parseDeepLink("huddle://invite/abc_DEF-123/"), { type: "invite", code: "abc_DEF-123" });
  assert.deepStrictEqual(parseDeepLink("HUDDLE://INVITE/AbC123xy"), { type: "invite", code: "AbC123xy" });
});
test("huddle://open just opens the app", () => {
  assert.deepStrictEqual(parseDeepLink("huddle://open"), { type: "open" });
  assert.deepStrictEqual(parseDeepLink("huddle://open/"), { type: "open" });
});
test("anything that isn't exactly those shapes is refused", () => {
  const bad = [
    "", null, undefined, 42, "https://invite/AbC123xy", "huddle:invite/AbC123xy", "huddle://invite", "huddle://invite/",
    "huddle://invite/short", "huddle://invite/" + "a".repeat(33), "huddle://invite/AbC123xy/extra", "huddle://invite/AbC 123xy",
    "huddle://invite/AbC123xy?next=https://evil.example", "huddle://invite/AbC123xy#x", "huddle://user:pw@invite/AbC123xy",
    "huddle://invite:80/AbC123xy", "huddle://invite/../../etc/passwd", "huddle://invite/%2e%2e%2f%2e%2e", "huddle://open/anything",
    "huddle://settings", "huddle://evil.example/invite/AbC123xy", "huddle://invite/AbC123xy\n--quit", "huddle://" + "a".repeat(300),
  ];
  for (const b of bad) assert.strictEqual(parseDeepLink(b), null, `should refuse ${JSON.stringify(b)}`);
});
test("the page to show for a link is built from the checked code only", () => {
  assert.strictEqual(invitePath({ type: "invite", code: "AbC123xy" }), "/invite/AbC123xy");
  assert.strictEqual(invitePath({ type: "open" }), null);
  assert.strictEqual(invitePath(null), null);
});

// ---- launch arguments
test("launch arguments: the link and the jump list commands are found among the rest", () => {
  const a = parseLaunchArgs(["C:\\Huddle.exe", "--some-electron-flag", "huddle://invite/AbC123xy"]);
  assert.deepStrictEqual(a.deepLink, { type: "invite", code: "AbC123xy" });
  assert.strictEqual(a.quit, false);
  assert.strictEqual(parseLaunchArgs(["x", "--quit"]).quit, true);
  assert.strictEqual(parseLaunchArgs(["x", "--check-updates"]).checkUpdates, true);
  assert.strictEqual(parseLaunchArgs(["x", "--open"]).open, true);
});
test("a bad link among the arguments is ignored, and only the first link counts", () => {
  assert.strictEqual(parseLaunchArgs(["x", "huddle://evil/..", "--open"]).deepLink, null);
  const a = parseLaunchArgs(["x", "huddle://invite/AAAAAA11", "huddle://invite/BBBBBB22"]);
  assert.deepStrictEqual(a.deepLink, { type: "invite", code: "AAAAAA11" });
  assert.deepStrictEqual(parseLaunchArgs(undefined), { deepLink: null, quit: false, checkUpdates: false, open: false });
});
test("the jump list has Open, Check for updates and Quit, each running this program", () => {
  const t = jumpListTasks("C:\\Huddle.exe");
  assert.deepStrictEqual(t.map((x) => x.arguments), ["--open", "--check-updates", "--quit"]);
  assert.ok(t.every((x) => x.program === "C:\\Huddle.exe" && x.title));
});

// ---- right-click menu
const noop = () => {};
const acts = (log = []) => ({
  replaceMisspelling: (w) => log.push(["replace", w]), addToDictionary: (w) => log.push(["add", w]), openExternal: (u) => log.push(["open", u]),
  copyText: (t) => log.push(["copy", t]), copyImage: (x, y) => log.push(["copyImage", x, y]), saveImage: (u) => log.push(["save", u]),
});
const labels = (items) => items.map((i) => i.label ?? i.role ?? i.type);

test("a misspelled word offers suggestions and adding it to the dictionary", () => {
  const log = [];
  const m = buildContextMenu({ misspelledWord: "teh", dictionarySuggestions: ["the", "tech"], isEditable: true }, acts(log));
  assert.deepStrictEqual(labels(m), ["the", "tech", 'Add "teh" to dictionary', "separator", "cut", "copy", "paste", "selectAll"]);
  m[2].click();
  assert.deepStrictEqual(log, [["add", "teh"]]);
});
test("a misspelled word with no suggestions says so; long words are shortened in the label", () => {
  const m = buildContextMenu({ misspelledWord: "x".repeat(40), dictionarySuggestions: [], isEditable: true }, acts());
  assert.strictEqual(m[0].label, "No suggestions");
  assert.strictEqual(m[0].enabled, false);
  assert.ok(m[1].label.length < 50 && m[1].label.includes("…"));
});
test("a link offers open and copy, but only for web addresses", () => {
  assert.deepStrictEqual(labels(buildContextMenu({ linkURL: "https://example.com/a" }, acts())), ["Open link in browser", "Copy link address"]);
  assert.deepStrictEqual(buildContextMenu({ linkURL: "file:///C:/secret.txt" }, acts()), []);
  assert.deepStrictEqual(buildContextMenu({ linkURL: "javascript:alert(1)" }, acts()), []);
});
test("a picture offers copy and save, but not for data: or file: pictures", () => {
  const log = [];
  const m = buildContextMenu({ mediaType: "image", srcURL: "https://huddle.example/api/files/1", x: 10, y: 20 }, acts(log));
  assert.deepStrictEqual(labels(m), ["Copy image", "Save image as…"]);
  m[0].click(); m[1].click();
  assert.deepStrictEqual(log, [["copyImage", 10, 20], ["save", "https://huddle.example/api/files/1"]]);
  assert.deepStrictEqual(buildContextMenu({ mediaType: "image", srcURL: "data:image/png;base64,AAAA" }, acts()), []);
});
test("selected text offers copy; an empty spot offers nothing; no stray separators", () => {
  assert.deepStrictEqual(labels(buildContextMenu({ selectionText: "hello" }, acts())), ["copy"]);
  assert.deepStrictEqual(buildContextMenu({}, acts()), []);
  const m = buildContextMenu({ linkURL: "https://a.example", mediaType: "image", srcURL: "https://a.example/i.png", selectionText: "t" }, acts());
  assert.notStrictEqual(m[m.length - 1].type, "separator");
});
