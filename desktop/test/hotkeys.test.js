const test = require("node:test");
const assert = require("node:assert");
const { normalizeAccelerator, sanitizeHotkeys, createHotkeyManager } = require("../src/hotkeys");

test("shortcuts are tidied into one standard form", () => {
  assert.strictEqual(normalizeAccelerator("ctrl+shift+space"), "Control+Shift+Space");
  assert.strictEqual(normalizeAccelerator("Shift+Ctrl+h"), "Control+Shift+H");
  assert.strictEqual(normalizeAccelerator("Win+Alt+F5"), "Alt+Super+F5");
  assert.strictEqual(normalizeAccelerator("Control + Alt + Enter"), "Control+Alt+Return");
  assert.strictEqual(normalizeAccelerator("ctrl+alt+1"), "Control+Alt+1");
  assert.strictEqual(normalizeAccelerator("ctrl+alt+up"), "Control+Alt+Up");
  assert.strictEqual(normalizeAccelerator("ctrl+alt+/"), "Control+Alt+/");
  assert.strictEqual(normalizeAccelerator("ctrl+f24"), "Control+F24");
});
test("a shortcut needs Ctrl, Alt or the Windows key, so no ordinary key is taken over", () => {
  for (const bad of ["A", "Shift+A", "F5", "Space", "Shift+Space", "Shift+F5", "Shift"]) assert.strictEqual(normalizeAccelerator(bad), null, bad);
  assert.strictEqual(normalizeAccelerator("Ctrl"), null); // modifiers alone are not a shortcut
});
test("malformed shortcuts are refused", () => {
  const bad = ["", "+", "Ctrl+", "Ctrl++A", "Ctrl+A+B", "Ctrl+Ctrl+A", "Ctrl+Nope", "Ctrl+F25", "Ctrl+F0", "Ctrl+Alt+Win+Shift+AB", null, undefined, 5, {}, "x".repeat(100)];
  for (const b of bad) assert.strictEqual(normalizeAccelerator(b), null, String(b));
});
test("combinations the system keeps for itself are refused", () => {
  for (const r of ["Alt+F4", "alt+tab", "Ctrl+Alt+Delete", "Win+L", "Win+D", "Ctrl+Esc"]) assert.strictEqual(normalizeAccelerator(r), null, r);
});

test("sanitizing keeps good shortcuts, blanks bad ones and flags a repeat", () => {
  const r = sanitizeHotkeys({ toggle: "ctrl+alt+h", switcher: "nonsense", unread: "Alt+Control+H" });
  assert.deepStrictEqual(r.hotkeys, { toggle: "Control+Alt+H", switcher: "", unread: "" });
  assert.deepStrictEqual(r.problems, { switcher: "invalid", unread: "duplicate" });
  assert.deepStrictEqual(sanitizeHotkeys(undefined), { hotkeys: { toggle: "", switcher: "", unread: "" }, problems: {} });
  assert.deepStrictEqual(sanitizeHotkeys({ toggle: "", switcher: null }).problems, {});
  assert.deepStrictEqual(sanitizeHotkeys({ bogus: "Ctrl+Alt+Z" }).hotkeys, { toggle: "", switcher: "", unread: "" }); // unknown actions are ignored
});

function rig(taken = []) {
  const r = { registered: new Map(), ran: [] };
  r.mgr = createHotkeyManager({
    register: (a, cb) => { if (taken.includes(a)) return false; r.registered.set(a, cb); return true; },
    unregister: (a) => r.registered.delete(a),
    run: (action) => r.ran.push(action),
  });
  return r;
}
test("registering ties each shortcut to its action", () => {
  const r = rig();
  const out = r.mgr.apply({ toggle: "Ctrl+Alt+H", unread: "Ctrl+Alt+U" });
  assert.deepStrictEqual(out.status, { toggle: "ok", switcher: "off", unread: "ok" });
  r.registered.get("Control+Alt+H")();
  r.registered.get("Control+Alt+U")();
  assert.deepStrictEqual(r.ran, ["toggle", "unread"]);
});
test("a shortcut another program already has is reported as taken", () => {
  const r = rig(["Control+Alt+H"]);
  const out = r.mgr.apply({ toggle: "Ctrl+Alt+H", switcher: "Ctrl+Alt+K" });
  assert.deepStrictEqual(out.status, { toggle: "taken", switcher: "ok", unread: "off" });
  assert.strictEqual(out.hotkeys.toggle, "Control+Alt+H"); // still remembered, so it can work if the other program lets go
  assert.deepStrictEqual([...r.registered.keys()], ["Control+Alt+K"]);
});
test("applying again replaces the old shortcuts; stop() removes them all", () => {
  const r = rig();
  r.mgr.apply({ toggle: "Ctrl+Alt+H" });
  r.mgr.apply({ switcher: "Ctrl+Alt+K" });
  assert.deepStrictEqual([...r.registered.keys()], ["Control+Alt+K"]);
  r.mgr.stop();
  assert.strictEqual(r.registered.size, 0);
});
test("a registration that throws counts as taken instead of crashing", () => {
  const mgr = createHotkeyManager({ register: () => { throw new Error("bad accelerator"); }, unregister: () => { throw new Error("nope"); }, run: () => {} });
  assert.deepStrictEqual(mgr.apply({ toggle: "Ctrl+Alt+H" }).status, { toggle: "taken", switcher: "off", unread: "off" });
  assert.doesNotThrow(() => mgr.stop());
});
