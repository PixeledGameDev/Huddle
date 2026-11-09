// Tests for ui/bridge.js, the script that gives Huddle's page `window.huddleDesktop`.
// Run with: node --test test   (from desktop-rs/)
//
// The important case is that the script runs BEFORE the page exists (document.documentElement and document.body are null),
// exactly as it does in the web view. If it throws there, `window.huddleDesktop` is never defined and the website thinks it
// is in an ordinary browser (no custom themes, no desktop settings, no notifications).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "ui", "bridge.js"), "utf8");

/** A just-enough fake of a page whose <html> element does not exist yet. */
function fakePage({ platform = "win32", protocol = "https:", hostname = "huddle.example.com", createElementThrows = false } = {}) {
  const sent = [];
  const documentListeners = new Map();
  const observed = [];
  class Element {}
  const makeEl = () => {
    const el = new Element();
    el.style = { cssText: "", setProperty() {} };
    el.isConnected = false;
    el.title = "";
    el.innerHTML = "";
    el.addEventListener = () => {};
    el.appendChild = (child) => { child.isConnected = true; el.children.push(child); return child; };
    el.children = [];
    el.attachShadow = () => ({
      innerHTML: "",
      querySelector: () => makeEl(),
    });
    return el;
  };
  const document = {
    readyState: "loading",
    documentElement: null,
    body: null,
    createElement: () => { if (createElementThrows) throw new Error("createElement failed"); return makeEl(); },
    addEventListener(type, fn) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push(fn); },
  };
  class MutationObserver {
    constructor(cb) { this.cb = cb; }
    observe(target) {
      // Like a real browser: observing something that isn't a node throws.
      if (!target || typeof target !== "object") throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
      observed.push(target);
    }
  }
  const window = { ipc: { postMessage: (m) => sent.push(JSON.parse(m)) } };
  const context = vm.createContext({
    window, document, Element, MutationObserver, console: { error() {}, log() {} },
    location: { protocol, hostname }, Map, Set, Promise, Object, JSON, RegExp, Error, TypeError,
  });
  const run = () => vm.runInContext(SOURCE.replace("__VERSION__", "9.9.9").replace("__PLATFORM__", platform), context);
  /** Pretend the page has now been parsed, then fire DOMContentLoaded. */
  const pageIsParsed = () => {
    document.documentElement = makeEl();
    document.body = makeEl();
    document.readyState = "interactive";
    for (const fn of documentListeners.get("DOMContentLoaded") ?? []) fn();
  };
  return { window, document, sent, observed, run, pageIsParsed };
}

test("window.huddleDesktop exists even though the page's <html> element does not exist yet", () => {
  const p = fakePage();
  assert.doesNotThrow(() => p.run());
  assert.ok(p.window.huddleDesktop, "the website would think it is in a browser");
  assert.strictEqual(p.window.huddleDesktop.isDesktop, true);
  assert.strictEqual(p.window.huddleDesktop.platform, "win32");
  assert.strictEqual(p.window.huddleDesktop.version, "9.9.9");
});

test("the window buttons are added once the page exists, not before", () => {
  const p = fakePage();
  p.run();
  assert.strictEqual(p.document.body, null);
  assert.strictEqual(p.observed.length, 0, "nothing may observe the page before it exists");
  p.pageIsParsed();
  assert.strictEqual(p.document.body.children.length, 1, "the window buttons were mounted in <body>");
  assert.strictEqual(p.observed[0], p.document.documentElement, "re-mounts if the page replaces <body>");
});

test("a failure in the page-touching parts cannot take the API down", () => {
  const p = fakePage({ createElementThrows: true });
  assert.doesNotThrow(() => p.run());
  assert.ok(p.window.huddleDesktop && p.window.huddleDesktop.isDesktop === true);
});

test("the API reaches the app through the message channel", () => {
  const p = fakePage();
  p.run();
  p.window.huddleDesktop.notify({ title: "hi" });
  assert.deepStrictEqual(p.sent, [{ cmd: "notify", args: { title: "hi" } }]);
});

test("macOS has no drawn window buttons but still has the API", () => {
  const p = fakePage({ platform: "darwin" });
  p.run();
  p.pageIsParsed();
  assert.strictEqual(p.window.huddleDesktop.platform, "darwin");
  assert.strictEqual(p.document.body.children.length, 0);
});

test("the app's own pages keep their own bridge: nothing is defined there", () => {
  const p = fakePage({ protocol: "huddleapp:", hostname: "localhost" });
  p.run();
  assert.strictEqual(p.window.huddleDesktop, undefined);
  const q = fakePage({ hostname: "huddleapp.localhost" });
  q.run();
  assert.strictEqual(q.window.huddleDesktop, undefined);
});
