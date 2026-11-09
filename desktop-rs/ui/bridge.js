// Injected into Huddle's own page (main frame only). It gives the page `window.huddleDesktop`, which is how the website knows it
// is running inside the desktop app (custom themes, desktop settings, notifications and so on all depend on it). Everything goes
// through one message channel; the app checks that each message really comes from the Huddle server's page before doing anything
// with it.
//
// This script runs before the page exists: `document.documentElement` and `document.body` are still null. So `window.huddleDesktop`
// is defined FIRST, before anything that touches the page, and every part that does touch the page waits for it and is guarded.
// (A crash in the title-bar code used to stop the script before `window.huddleDesktop` was defined, and the website then behaved
// as if it was running in an ordinary browser.)
(() => {
  if (window.huddleDesktop) return;
  // The app's own pages (setup) have their own small bridge.
  if (location.protocol === "huddleapp:" || location.hostname === "huddleapp.localhost") return;
  const VERSION = "__VERSION__";
  const PLATFORM = "__PLATFORM__"; // "win32", "darwin" or "linux" (the names the page expects)
  const TITLEBAR_H = 40;

  const pending = new Map();
  const listeners = new Map();
  let seq = 0;
  const post = (m) => window.ipc.postMessage(JSON.stringify(m));
  const send = (cmd, args) => post({ cmd, args });
  const invoke = (cmd, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); post({ id, cmd, args }); });
  // `transform` may turn the payload into [value] to hand to the page, or into null to ignore it.
  const subscribe = (name, cb, transform) => {
    if (typeof cb !== "function") return () => {};
    const handler = (payload) => {
      if (!transform) return cb(payload);
      const r = transform(payload);
      if (r) cb(r[0]);
    };
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => listeners.get(name)?.delete(handler);
  };
  Object.defineProperty(window, "__huddle", {
    value: Object.freeze({
      resolve: (id, value) => { const r = pending.get(id); if (r) { pending.delete(id); r(value); } },
      emit: (name, payload) => { listeners.get(name)?.forEach((h) => { try { h(payload); } catch (e) { console.error(e); } }); },
    }),
  });

  // ---------- the API the page sees ----------
  // Defined before anything below touches the page, so nothing after this point can stop the website from seeing the desktop app.
  let setControlColors = () => {};
  const hex = /^#[0-9a-f]{6}$/i;
  const api = {
    isDesktop: true,
    platform: PLATFORM,
    version: VERSION,
    titleBar: {
      height: TITLEBAR_H,
      openMenu: (x, y) => send("menu:popup", { x, y }),
      setColors: (color, symbolColor) => { if (hex.test(color) && hex.test(symbolColor)) setControlColors(color, symbolColor); },
    },
    notify: (n) => send("notify", n),
    setBadge: (count, iconDataUrl) => send("badge", { count, iconDataUrl }),
    getUpdateState: () => invoke("update:state"),
    onUpdateState: (cb) => subscribe("update:state", cb),
    checkForUpdates: () => invoke("update:check"),
    installUpdate: () => send("update:install"),
    getStartup: () => invoke("startup:get"),
    setStartup: (v) => invoke("startup:set", v),
    getHotkeys: () => invoke("hotkeys:get"),
    setHotkeys: (hotkeys) => invoke("hotkeys:set", hotkeys),
    pauseHotkeys: (paused) => send("hotkeys:pause", !!paused),
    onCommand: (cb) => subscribe("command", cb, (c) => (c === "switcher" || c === "unread" ? [c] : null)),
    setProgress: (fraction) => send("progress:set", fraction),
    getIdleSettings: () => invoke("idle:get"),
    setIdleSettings: (v) => invoke("idle:set", v),
    onIdleChange: (cb) => subscribe("idle:change", cb, (idle) => [!!idle]),
    onNotificationReply: (cb) => subscribe("notification-reply", cb),
    replyResult: (id, ok, error) => send("reply-result", { id, ok, error }),
    onNotificationMarkRead: (cb) => subscribe("notification-markread", cb),
    getUpdateInfo: () => invoke("update-info"),
    syncNotifyPrefs: (prefs) => send("notify-prefs", prefs),
    pageReady: () => send("page-ready"),
    onNotificationClick: (cb) => subscribe("notification-click", cb),
  };
  Object.defineProperty(window, "huddleDesktop", { value: Object.freeze(api), enumerable: true });

  // ---------- helpers for the parts that touch the page ----------
  // One broken part must never take the others (or the API above) down with it.
  const guard = (what, fn) => { try { fn(); } catch (e) { console.error("Huddle desktop bridge: " + what + " failed", e); } };
  // Runs `fn` once the page's own elements exist (this script runs before they do).
  const whenPageExists = (fn) => {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => guard("page setup", fn), { once: true });
    else guard("page setup", fn);
  };

  // ---------- window buttons (minimize / maximize / close), drawn by us because the window has no system title bar ----------
  guard("window buttons", () => {
    if (PLATFORM === "darwin") return;
    const host = document.createElement("div");
    host.style.cssText = `position:fixed;top:0;right:0;height:${TITLEBAR_H}px;z-index:2147483647;`;
    const root = host.attachShadow({ mode: "closed" });
    const icons = {
      min: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" fill="none"/></svg>',
      max: '<svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" stroke="currentColor" fill="none"/></svg>',
      restore: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 2.5v-2h7v7h-2M.5 2.5h7v7h-7z" stroke="currentColor" fill="none"/></svg>',
      close: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" fill="none"/></svg>',
    };
    root.innerHTML = `<style>
      :host { all: initial; }
      .bar { display: flex; height: ${TITLEBAR_H}px; background: var(--bg, #0f1322); color: var(--fg, #e8ecf8); }
      button { all: unset; width: 46px; height: 100%; display: grid; place-items: center; cursor: default; }
      button:hover { background: rgba(128,128,128,.25); }
      button.close:hover { background: #e81123; color: #fff; }
    </style>
    <div class="bar"><button class="min" aria-label="Minimize" title="Minimize"></button><button class="max" aria-label="Maximize" title="Maximize"></button><button class="close" aria-label="Close" title="Close"></button></div>`;
    const q = (s) => root.querySelector(s);
    q(".min").innerHTML = icons.min;
    q(".max").innerHTML = icons.max;
    q(".close").innerHTML = icons.close;
    q(".min").addEventListener("click", () => send("win:minimize"));
    q(".max").addEventListener("click", () => send("win:toggle-maximize"));
    q(".close").addEventListener("click", () => send("win:close"));
    setControlColors = (bg, fg) => { host.style.setProperty("--bg", bg); host.style.setProperty("--fg", fg); q(".bar").style.setProperty("--bg", bg); q(".bar").style.setProperty("--fg", fg); };
    listeners.set("window:state", new Set([(s) => {
      q(".max").innerHTML = s?.maximized ? icons.restore : icons.max;
      q(".max").title = s?.maximized ? "Restore" : "Maximize";
      host.style.display = s?.fullscreen ? "none" : "";
    }]));
    const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
    // The page's <html> element doesn't exist yet when this script runs, so wait for it before mounting or watching it.
    whenPageExists(() => {
      mount();
      new MutationObserver(mount).observe(document.documentElement, { childList: true });
    });
  });

  // ---------- dragging the window by the title bar ----------
  // Windows handles `-webkit-app-region: drag` itself. On macOS and Linux the page's engine doesn't, so the title bar is found by its class.
  guard("window dragging", () => {
    if (PLATFORM === "win32") return;
    const inBar = (t) => t instanceof Element && t.closest(".titlebar") && !t.closest("button,a,input,select,textarea,[role=button]");
    document.addEventListener("mousedown", (e) => { if (e.button === 0 && e.detail === 1 && inBar(e.target)) send("win:drag"); }, true);
    document.addEventListener("dblclick", (e) => { if (inBar(e.target)) send("win:toggle-maximize"); }, true);
  });
  // Without a system frame, Linux needs its own edges to resize from.
  guard("window resizing", () => {
    if (PLATFORM !== "linux") return;
    const EDGE = 6;
    const dir = (e) => {
      const w = window.innerWidth, h = window.innerHeight;
      const n = e.clientY < EDGE, s = e.clientY > h - EDGE, west = e.clientX < EDGE, east = e.clientX > w - EDGE;
      return n ? (west ? "NorthWest" : east ? "NorthEast" : "North") : s ? (west ? "SouthWest" : east ? "SouthEast" : "South") : west ? "West" : east ? "East" : null;
    };
    const cursors = { North: "ns-resize", South: "ns-resize", East: "ew-resize", West: "ew-resize", NorthWest: "nwse-resize", SouthEast: "nwse-resize", NorthEast: "nesw-resize", SouthWest: "nesw-resize" };
    document.addEventListener("mousemove", (e) => { const d = dir(e); document.documentElement.style.cursor = d ? cursors[d] : ""; }, true);
    document.addEventListener("mousedown", (e) => { const d = e.button === 0 && dir(e); if (d) { e.preventDefault(); send("win:resize", d); } }, true);
  });

  // Without a menu bar the usual shortcuts have to be handled here.
  guard("keyboard shortcuts", () => {
    document.addEventListener("keydown", (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      let handled = true;
      if (key === "f12" || (ctrl && e.shiftKey && key === "i")) send("devtools");
      else if (key === "f5" || (ctrl && key === "r")) send("reload");
      else if (ctrl && (key === "=" || key === "+")) send("zoom", 0.5);
      else if (ctrl && key === "-") send("zoom", -0.5);
      else if (ctrl && key === "0") send("zoom", 0);
      else if (key === "f11") send("win:fullscreen");
      else handled = false;
      if (handled) e.preventDefault();
    }, true);
  });
})();
