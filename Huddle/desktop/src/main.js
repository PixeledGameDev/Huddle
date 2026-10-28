const { app, BrowserWindow, Menu, Tray, Notification, ipcMain, nativeImage, net, screen, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { normalizeServerUrl, sameOrigin, isSafeExternal } = require("./url");
const { updateFeedUrl, canAutoUpdate, createUpdater } = require("./update");

/**
 * Huddle desktop: a window onto your Huddle server, plus the desktop extras (system notifications, an unread badge,
 * a tray icon, and staying open in the tray when you close the window).
 *
 * The app contains no copy of Huddle itself. It loads your server's own web app, so it is always the same version as
 * the server, and signing in works exactly like it does in a browser.
 */
const isMac = process.platform === "darwin";
const SETUP_PAGE = path.join(__dirname, "setup.html");
const ICON = path.join(__dirname, "..", "build", "icon.png");
const TRAY_ICON = path.join(__dirname, "..", "build", "tray.png");
const TRAY_ICON_UNREAD = path.join(__dirname, "..", "build", "tray-unread.png");

app.setAppUserModelId("app.huddle.desktop");

// ---------- settings (a small JSON file in the user's app data folder) ----------
const DEFAULTS = {
  serverUrl: null,
  closeToTray: true,
  bounds: null,
  maximized: false,
  launchAtStartup: true, // open Huddle when the person signs in to their computer
  startInBackground: false, // ...and if so, whether to leave the window closed (it's still in the tray)
};
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try {
    settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    settings = { ...DEFAULTS };
  }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
    } catch (e) {
      console.error("Couldn't save settings", e);
    }
  }, 300);
}

/** The server to open: what the person chose, else HUDDLE_URL, else the address baked into app.config.json. */
function serverUrl() {
  if (settings.serverUrl) return settings.serverUrl;
  let configured = null;
  try {
    configured = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.config.json"), "utf8")).defaultUrl;
  } catch { /* no config file */ }
  return normalizeServerUrl(process.env.HUDDLE_URL) ?? normalizeServerUrl(configured);
}

// ---------- splash screen ----------
const TITLEBAR_H = 40; // the web page draws the title bar; this is its height
const SPLASH_PAGE = path.join(__dirname, "splash.html");
const SPLASH_MIN_MS = 1200; // long enough to read, short enough not to feel slow
let splash = null;
let splashShownAt = 0;
let splashStatus = { text: "Starting…", version: app.getVersion() };

function showSplash() {
  splash = new BrowserWindow({
    width: 420,
    height: 380,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    skipTaskbar: true,
    title: "Huddle",
    backgroundColor: "#1a2036",
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: { preload: path.join(__dirname, "splash-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  splash.webContents.on("will-navigate", (e) => e.preventDefault());
  splash.once("ready-to-show", () => {
    splashShownAt = Date.now();
    splash?.show();
  });
  splash.on("closed", () => { splash = null; });
  void splash.loadFile(SPLASH_PAGE);
}
function setSplash(text, percent) {
  splashStatus = { text, percent, version: app.getVersion() };
  splash?.webContents.send("splash:status", splashStatus);
}
ipcMain.on("splash:ready", (e) => {
  if (splash && e.sender === splash.webContents) e.sender.send("splash:status", splashStatus);
});
/** Closes the splash once it has been on screen long enough. */
function closeSplash() {
  if (!splash) return;
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  setTimeout(() => { if (splash && !splash.isDestroyed()) splash.close(); }, splashShownAt ? wait : 0);
}

// ---------- Huddle's own popups (instead of the system's grey message boxes) ----------
const DIALOG_PAGE = path.join(__dirname, "dialog.html");
const openDialogs = new Map(); // webContents id -> { resolve, opts }
/**
 * Shows a popup in Huddle's style and resolves with the index of the button pressed.
 * Options: type ("info" | "warning"), message, detail, buttons (default ["OK"]), defaultId, cancelId.
 */
function showDialog(opts) {
  const buttons = Array.isArray(opts.buttons) && opts.buttons.length ? opts.buttons.map(String) : ["OK"];
  const o = { type: opts.type ?? "info", message: String(opts.message ?? ""), detail: opts.detail ? String(opts.detail) : "", buttons, defaultId: opts.defaultId ?? 0, cancelId: opts.cancelId ?? buttons.length - 1 };
  return new Promise((resolve) => {
    const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
    const d = new BrowserWindow({
      width: 440,
      height: 300,
      parent,
      modal: !!parent,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      show: false,
      skipTaskbar: !!parent,
      title: "Huddle",
      icon: fs.existsSync(ICON) ? ICON : undefined,
      webPreferences: { preload: path.join(__dirname, "dialog-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const id = d.webContents.id;
    let settled = false;
    const finish = (index) => {
      if (settled) return;
      settled = true;
      openDialogs.delete(id);
      resolve(index);
      if (!d.isDestroyed()) d.close();
    };
    openDialogs.set(id, { opts: o, finish });
    d.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    d.webContents.on("will-navigate", (e) => e.preventDefault());
    d.on("closed", () => finish(o.cancelId));
    void d.loadFile(DIALOG_PAGE);
  });
}
const dialogFor = (e) => openDialogs.get(e.sender.id);
ipcMain.on("dialog:ready", (e) => {
  const d = dialogFor(e);
  if (d) e.sender.send("dialog:show", d.opts);
});
ipcMain.on("dialog:choose", (e, index) => {
  const d = dialogFor(e);
  if (d && Number.isInteger(index) && index >= 0 && index < d.opts.buttons.length) d.finish(index);
});
ipcMain.on("dialog:size", (e, height) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !dialogFor(e) || !Number.isFinite(height)) return;
  w.setContentSize(440, Math.max(140, Math.min(Math.round(height), 600)));
  w.center();
  w.show();
});

// ---------- automatic updates ----------
let updater = null;
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function initUpdater() {
  if (!canAutoUpdate({ isPackaged: app.isPackaged, platform: process.platform, env: process.env })) return;
  try {
    const { autoUpdater } = require("electron-updater");
    updater = createUpdater({
      autoUpdater,
      log: (...a) => console.error(...a),
      onState: (state) => {
        buildMenus();
        for (const w of BrowserWindow.getAllWindows()) if (w !== splash && !w.isDestroyed()) w.webContents.send("update:state", state);
        if (state.status === "ready") announceUpdate(state);
      },
    });
  } catch (e) {
    console.error("Automatic updates are unavailable", e);
  }
}
const feedUrl = () => updateFeedUrl(serverUrl());
let announcedVersion = null;
/** Tells the person (once per version) that an update is waiting, even if the window is closed to the tray. */
function announceUpdate(state) {
  if (announcedVersion === state.version || !Notification.isSupported()) return;
  announcedVersion = state.version;
  const note = new Notification({ title: "Huddle update ready", body: `Version ${state.version} is downloaded. Click to restart and install it.`, silent: true, icon: fs.existsSync(ICON) ? ICON : undefined });
  note.on("click", installUpdate);
  note.show();
}
function installUpdate() {
  if (updater?.getState().status !== "ready") return;
  quitting = true;
  updater.installNow();
}
async function checkNow() {
  if (!updater) {
    await showDialog({ type: "info", message: "Automatic updates aren't available for this copy of Huddle.", detail: "Installed copies of the app update themselves. Linux .deb users should install the newer .deb from your server's download page." });
    return;
  }
  const state = await updater.check(feedUrl());
  const current = app.getVersion();
  if (state.status === "ready") {
    const r = await showDialog({ type: "info", message: `Huddle ${state.version} is ready to install.`, detail: "Restart Huddle to finish updating.", buttons: ["Restart now", "Later"], defaultId: 0, cancelId: 1 });
    if (r === 0) installUpdate();
  } else if (state.status === "downloading") {
    await showDialog({ type: "info", message: `Downloading Huddle ${state.version}…`, detail: "You'll get a notification when it's ready to install." });
  } else if (state.status === "error") {
    await showDialog({ type: "warning", message: "Couldn't check for updates.", detail: state.message });
  } else {
    await showDialog({ type: "info", message: "You're up to date.", detail: `Huddle ${current}` });
  }
}
ipcMain.handle("update:state", (e) => (fromHuddle(e) ? updater?.getState() ?? { status: "unsupported" } : null));
ipcMain.handle("update:check", async (e) => (fromHuddle(e) && updater ? updater.check(feedUrl()) : null));
ipcMain.on("update:install", (e) => fromHuddle(e) && installUpdate());

/** Splash step: look for an update before opening Huddle, and install it straight away if there is one. */
async function startupUpdate() {
  if (!updater || !feedUrl()) return "none";
  setSplash("Checking for updates…");
  const slow = setTimeout(() => setSplash("Still checking… the server may be waking up"), 5000);
  const result = await updater.startupCheck(feedUrl(), {
    onProgress: (s) => setSplash(`Downloading update${s.version ? ` ${s.version}` : ""}${typeof s.percent === "number" && s.percent > 0 ? ` · ${s.percent}%` : "…"}`, s.percent),
  });
  clearTimeout(slow);
  if (result !== "ready") return "none";
  setSplash("Installing update… Huddle will reopen by itself.");
  await new Promise((r) => setTimeout(r, 1500)); // long enough to read
  installUpdate();
  return "installing";
}

// ---------- the window ----------
let win = null;
let tray = null;
let quitting = false;
let startHidden = false; // set at start-up when Huddle should open without showing a window

function visibleBounds(b) {
  if (!b) return null;
  const onScreen = screen.getAllDisplays().some((d) => b.x < d.bounds.x + d.bounds.width - 40 && b.x + b.width > d.bounds.x + 40 && b.y >= d.bounds.y - 10 && b.y < d.bounds.y + d.bounds.height - 40);
  return onScreen ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const b = visibleBounds(settings.bounds);
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...b,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: "Huddle",
    backgroundColor: "#0f1322",
    icon: fs.existsSync(ICON) ? ICON : undefined,
    // No native title bar or menu bar: Huddle draws its own (logo menu, title, window buttons from the system).
    titleBarStyle: "hidden",
    ...(isMac ? { trafficLightPosition: { x: 16, y: 13 } } : { titleBarOverlay: { color: "#0f1322", symbolColor: "#e8ecf8", height: TITLEBAR_H } }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      additionalArguments: [`--huddle-version=${app.getVersion()}`],
    },
  });
  const wc = win.webContents;
  wc.setUserAgent(`${wc.getUserAgent()} HuddleDesktop/${app.getVersion()}`);
  if (!isMac) win.setMenuBarVisibility(false);
  // Without a menu bar the usual shortcuts have to be handled here.
  wc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (key === "f12" || (ctrl && input.shift && key === "i")) { wc.toggleDevTools(); e.preventDefault(); }
    else if (key === "f5" || (ctrl && key === "r")) { input.shift ? wc.reloadIgnoringCache() : wc.reload(); e.preventDefault(); }
    else if (ctrl && (key === "=" || key === "+")) { wc.setZoomLevel(wc.getZoomLevel() + 0.5); e.preventDefault(); }
    else if (ctrl && key === "-") { wc.setZoomLevel(wc.getZoomLevel() - 0.5); e.preventDefault(); }
    else if (ctrl && key === "0") { wc.setZoomLevel(0); e.preventDefault(); }
    else if (key === "f11") { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
  });

  win.once("ready-to-show", () => {
    if (settings.maximized) win.maximize();
    if (startHidden) {
      startHidden = false; // opened with the computer in the background: stay in the tray until the person opens it
      closeSplash();
      return;
    }
    win.show();
    closeSplash();
  });
  const remember = () => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    settings.maximized = win.isMaximized();
    if (!win.isMaximized()) settings.bounds = win.getNormalBounds();
    saveSettings();
  };
  win.on("resize", remember);
  win.on("move", remember);
  win.on("maximize", remember);
  win.on("unmaximize", remember);
  win.on("focus", () => win.flashFrame(false));
  win.on("close", (e) => {
    if (quitting || !settings.closeToTray) return;
    e.preventDefault();
    win.hide();
  });
  win.on("closed", () => { win = null; });

  // Only Huddle itself loads in this window. Everything else opens in the person's own browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url, serverUrl())) wc.downloadURL(url); // a file from Huddle: download it, signed in
    else if (isSafeExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  const guard = (e, url) => {
    if (sameOrigin(url, serverUrl()) || isSetupUrl(url)) return;
    e.preventDefault();
    if (isSafeExternal(url)) void shell.openExternal(url);
  };
  wc.on("will-navigate", guard);
  wc.on("will-redirect", guard);
  wc.on("did-fail-load", (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void win?.loadFile(SETUP_PAGE, { query: { failed: "1" } }); // -3 = a navigation that was replaced
  });
  wc.on("context-menu", (_e, params) => {
    const items = [];
    for (const word of params.dictionarySuggestions ?? []) items.push({ label: word, click: () => wc.replaceMisspelling(word) });
    if (items.length) items.push({ type: "separator" });
    if (params.linkURL && isSafeExternal(params.linkURL)) {
      items.push({ label: "Open link in browser", click: () => void shell.openExternal(params.linkURL) });
      items.push({ label: "Copy link address", click: () => require("electron").clipboard.writeText(params.linkURL) });
      items.push({ type: "separator" });
    }
    if (params.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    else if (params.selectionText) items.push({ role: "copy" });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  loadApp();
}

function loadApp() {
  if (!win) return;
  const url = serverUrl();
  if (!url) return showSetup();
  void win.loadURL(url).catch(() => {}); // failures are handled by did-fail-load
}
function showSetup() {
  void win?.loadFile(SETUP_PAGE);
}
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------- who is allowed to talk to the main process ----------
function isSetupUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "file:" && path.normalize(fileURLToPath(u)) === path.normalize(SETUP_PAGE);
  } catch {
    return false;
  }
}
const fromSetupPage = (e) => !!e.senderFrame && isSetupUrl(e.senderFrame.url);
const fromHuddle = (e) => !!e.senderFrame && e.senderFrame === e.sender.mainFrame && sameOrigin(e.senderFrame.url, serverUrl());

async function looksLikeHuddle(origin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await net.fetch(`${origin}/healthz`, { signal: controller.signal });
    return res.ok && (await res.text()).trim() === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle("setup:current", (e) => (fromSetupPage(e) ? serverUrl() : null));
ipcMain.handle("setup:save", async (e, input) => {
  if (!fromSetupPage(e)) return { error: "Not allowed." };
  const url = normalizeServerUrl(input);
  if (!url) return { error: "That doesn't look like a valid address. It should start with https://, like https://huddle.example.com." };
  if (!(await looksLikeHuddle(url))) return { error: `Couldn't find a Huddle server at ${url}. Check the address and your connection.` };
  settings.serverUrl = url;
  saveSettings();
  loadApp();
  if (updater) void updater.check(feedUrl());
  return { ok: true };
});
ipcMain.on("setup:retry", (e) => fromSetupPage(e) && loadApp());
ipcMain.on("setup:change", (e) => fromSetupPage(e) && showSetup());

// ---------- notifications and the unread badge ----------
const UUID = /^[0-9a-f-]{36}$/i;
const text = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const liveNotes = new Map(); // tag -> Notification, so a channel has one notification that updates rather than a pile
ipcMain.on("notify", (e, n) => {
  if (!fromHuddle(e) || !n || typeof n !== "object") return;
  const title = text(n.title, 100);
  if (!title) return;
  const target = n.target && UUID.test(n.target.serverId) && UUID.test(n.target.channelId) ? { serverId: n.target.serverId, channelId: n.target.channelId } : null;
  const tag = text(n.tag, 64);
  try {
    showToast({ title, body: text(n.body, 250), tag, target }); // Huddle's own popup, with a box to reply in
  } catch (err) {
    console.error("Couldn't show the reply popup, using a system notification", err);
    showSystemNotification({ title, body: text(n.body, 250), tag, target });
  }
  if (win && !win.isFocused()) win.flashFrame(true);
});

/** The plain system notification (no reply box): kept as a fallback if the popup can't be made. */
function showSystemNotification({ title, body, tag, target }) {
  if (!Notification.isSupported()) return;
  if (tag) liveNotes.get(tag)?.close();
  const note = new Notification({ title, body, silent: true, icon: fs.existsSync(ICON) ? ICON : undefined }); // Huddle plays its own chime
  if (tag) liveNotes.set(tag, note);
  note.on("click", () => {
    showWindow();
    if (target) win?.webContents.send("notification-click", target);
  });
  note.on("close", () => tag && liveNotes.get(tag) === note && liveNotes.delete(tag));
  note.show();
}

// ---------- reply popups ----------
// A small Huddle-styled popup in the corner of the screen: read the message, type a reply and send it, mark it read, or open it.
const TOAST_PAGE = path.join(__dirname, "toast.html");
const TOAST_W = 380;
const TOAST_H = 178;
const MAX_TOASTS = 3;
const toasts = []; // newest first: { win, tag, target, timer, held }
const toastFor = (e) => toasts.find((t) => !t.win.isDestroyed() && t.win.webContents.id === e.sender.id);

function layoutToasts() {
  const wa = screen.getPrimaryDisplay().workArea;
  toasts.forEach((t, i) => {
    if (!t.win.isDestroyed()) t.win.setBounds({ x: wa.x + wa.width - TOAST_W, y: wa.y + wa.height - TOAST_H * (i + 1), width: TOAST_W, height: TOAST_H });
  });
}
function closeToast(t) {
  clearTimeout(t.timer);
  const i = toasts.indexOf(t);
  if (i >= 0) toasts.splice(i, 1);
  if (!t.win.isDestroyed()) t.win.close();
  layoutToasts();
}
function armToast(t, ms = 9000) {
  clearTimeout(t.timer);
  if (!t.held) t.timer = setTimeout(() => closeToast(t), ms);
}
function showToast({ title, body, tag, target }) {
  const content = { title, body, canReply: !!target };
  const existing = tag ? toasts.find((t) => t.tag === tag && !t.win.isDestroyed()) : null;
  if (existing) { // another message in the same conversation: update the popup instead of stacking a new one
    existing.target = target;
    existing.win.webContents.send("toast:show", content);
    armToast(existing);
    return;
  }
  const w = new BrowserWindow({
    width: TOAST_W,
    height: TOAST_H,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: "Huddle",
    webPreferences: { preload: path.join(__dirname, "toast-preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const t = { win: w, tag, target, timer: null, held: false, content };
  toasts.unshift(t);
  if (toasts.length > MAX_TOASTS) closeToast(toasts[toasts.length - 1]);
  layoutToasts();
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  w.webContents.on("will-navigate", (ev) => ev.preventDefault());
  w.on("closed", () => { clearTimeout(t.timer); const i = toasts.indexOf(t); if (i >= 0) toasts.splice(i, 1); layoutToasts(); });
  void w.loadFile(TOAST_PAGE);
}
ipcMain.on("toast:ready", (e) => {
  const t = toastFor(e);
  if (!t) return;
  e.sender.send("toast:show", t.content);
  t.win.showInactive(); // appears without taking focus from what you're doing
  armToast(t);
});
ipcMain.on("toast:close", (e) => { const t = toastFor(e); if (t) closeToast(t); });
ipcMain.on("toast:hold", (e, on) => {
  const t = toastFor(e);
  if (!t) return;
  t.held = !!on;
  if (on) clearTimeout(t.timer);
  else armToast(t, 4000);
});
ipcMain.on("toast:open", (e) => {
  const t = toastFor(e);
  if (!t) return;
  showWindow();
  if (t.target) win?.webContents.send("notification-click", t.target);
  closeToast(t);
});
ipcMain.on("toast:markread", (e) => {
  const t = toastFor(e);
  if (!t) return;
  if (t.target) win?.webContents.send("notification-markread", t.target);
  closeToast(t);
});
// Replying: the popup hands the text to the Huddle page, which sends it with the person's own session, then says how it went.
const pendingReplies = new Map();
let replySeq = 0;
ipcMain.handle("toast:reply", async (e, raw) => {
  const t = toastFor(e);
  const body = text(raw, 2000).trim();
  if (!t || !t.target || !body) return { ok: false, error: "Nothing to send." };
  if (!win || win.isDestroyed()) return { ok: false, error: "Huddle isn't running." };
  const id = ++replySeq;
  const result = await new Promise((resolve) => {
    pendingReplies.set(id, resolve);
    setTimeout(() => pendingReplies.delete(id) && resolve({ ok: false, error: "That took too long. Try again." }), 12000);
    win.webContents.send("notification-reply", { id, target: t.target, text: body });
  });
  if (result.ok) setTimeout(() => closeToast(t), 1100);
  return result;
});
ipcMain.on("reply-result", (e, p) => {
  if (!fromHuddle(e) || !p || !Number.isInteger(p.id)) return;
  const resolve = pendingReplies.get(p.id);
  if (!resolve) return;
  pendingReplies.delete(p.id);
  resolve({ ok: !!p.ok, error: text(p.error, 120) });
});

ipcMain.on("badge", (e, p) => {
  if (!fromHuddle(e) || !p) return;
  const count = Number.isInteger(p.count) && p.count > 0 ? Math.min(p.count, 9999) : 0;
  if (isMac) app.dock?.setBadge(count ? String(count) : "");
  else if (process.platform === "linux") app.setBadgeCount(count);
  else if (win) {
    const ok = count > 0 && typeof p.iconDataUrl === "string" && p.iconDataUrl.startsWith("data:image/png;base64,") && p.iconDataUrl.length < 60000;
    win.setOverlayIcon(ok ? nativeImage.createFromDataURL(p.iconDataUrl) : null, count ? `${count} unread` : "");
  }
  tray?.setToolTip(count ? `Huddle (${count} unread)` : "Huddle");
  setTrayUnread(count > 0);
});

// ---------- starting with the computer ----------
/** True when the system started Huddle at sign-in with the "background" choice (see applyStartup). */
const launchedHidden = process.argv.includes("--hidden") || (() => { try { return !!app.getLoginItemSettings().wasOpenedAsHidden; } catch { return false; } })();
const autostartFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(require("node:os").homedir(), ".config"), "autostart", "huddle.desktop");

/** Makes the computer's startup list match the person's choices. Only an installed app does this, so a dev run never registers itself. */
function applyStartup() {
  if (!app.isPackaged) return;
  const args = settings.startInBackground ? ["--hidden"] : [];
  try {
    if (process.platform === "linux") {
      const file = autostartFile();
      if (!settings.launchAtStartup) return void fs.rmSync(file, { force: true });
      const exe = process.env.APPIMAGE || process.execPath;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Huddle\nExec="${exe}" ${args.join(" ")}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      app.setLoginItemSettings({ openAtLogin: settings.launchAtStartup, openAsHidden: settings.startInBackground, args });
    }
  } catch (e) {
    console.error("Couldn't update the start-with-computer setting", e);
  }
}
function setStartup(patch) {
  if (typeof patch.launchAtStartup === "boolean") settings.launchAtStartup = patch.launchAtStartup;
  if (typeof patch.startInBackground === "boolean") settings.startInBackground = patch.startInBackground;
  saveSettings();
  applyStartup();
  buildMenus();
}
const startupState = () => ({ supported: app.isPackaged, launch: settings.launchAtStartup, background: settings.startInBackground });
ipcMain.handle("startup:get", (e) => (fromHuddle(e) ? startupState() : null));
ipcMain.handle("startup:set", (e, v) => {
  if (!fromHuddle(e) || !v || typeof v !== "object") return null;
  setStartup({ launchAtStartup: v.launch, startInBackground: v.background });
  return startupState();
});
function startupItems() {
  return [
    { label: "Start Huddle when I sign in to my computer", type: "checkbox", checked: settings.launchAtStartup, click: (item) => setStartup({ launchAtStartup: item.checked }) },
    { label: "Start in the background (don't show the window)", type: "checkbox", checked: settings.startInBackground, enabled: settings.launchAtStartup, click: (item) => setStartup({ startInBackground: item.checked }) },
  ];
}

// ---------- tray and menus ----------
function toggleCloseToTray(item) {
  settings.closeToTray = item.checked;
  saveSettings();
  buildMenus();
}
function changeServer() {
  showWindow();
  showSetup();
}
function updateMenuItems() {
  const s = updater?.getState();
  const items = [{ type: "separator" }];
  if (s?.status === "ready") items.push({ label: `Restart to update to ${s.version}`, click: installUpdate });
  else if (s?.status === "downloading") items.push({ label: `Downloading update${s.percent ? ` (${s.percent}%)` : ""}…`, enabled: false });
  else items.push({ label: "Check for updates…", click: () => void checkNow() });
  return items;
}
/** The Huddle menu: opened from the logo in the title bar (and used for the macOS menu bar). */
function huddleMenuTemplate() {
  const zoom = (d) => win?.webContents.setZoomLevel(d === 0 ? 0 : win.webContents.getZoomLevel() + d);
  return [
    { label: "Change server…", click: changeServer },
    { label: "Keep running in the tray when closed", type: "checkbox", checked: settings.closeToTray, click: toggleCloseToTray },
    ...startupItems(),
    ...updateMenuItems(),
    { type: "separator" },
    { label: "Zoom in", accelerator: "CmdOrCtrl+=", click: () => zoom(0.5) },
    { label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => zoom(-0.5) },
    { label: "Actual size", accelerator: "CmdOrCtrl+0", click: () => zoom(0) },
    { label: "Full screen", accelerator: "F11", click: () => win?.setFullScreen(!win.isFullScreen()) },
    { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
    { label: "Developer tools", accelerator: "F12", click: () => win?.webContents.toggleDevTools() },
    { type: "separator" },
    { label: "Quit Huddle", click: () => { quitting = true; app.quit(); } },
  ];
}
ipcMain.on("menu:popup", (e, pos) => {
  if (!fromHuddle(e) || !win) return;
  const z = win.webContents.getZoomFactor();
  const x = Number.isFinite(pos?.x) ? Math.max(0, Math.round(pos.x * z)) : 0;
  const y = Number.isFinite(pos?.y) ? Math.max(0, Math.round(pos.y * z)) : TITLEBAR_H;
  Menu.buildFromTemplate(huddleMenuTemplate()).popup({ window: win, x, y });
});
/** The title bar follows the app's colors so the window buttons blend in. */
ipcMain.on("titlebar:colors", (e, c) => {
  if (!fromHuddle(e) || !win || isMac) return;
  const hex = /^#[0-9a-f]{6}$/i;
  if (!hex.test(c?.color) || !hex.test(c?.symbolColor)) return;
  try { win.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: TITLEBAR_H }); } catch { /* not supported here */ }
});

function buildMenus() {
  const trayItems = [
    { label: "Open Huddle", click: showWindow },
    { label: "Keep running in the tray when closed", type: "checkbox", checked: settings.closeToTray, click: toggleCloseToTray },
    ...startupItems(),
    { label: "Change server…", click: changeServer },
    ...updateMenuItems(),
    { type: "separator" },
    { label: "Quit Huddle", click: () => { quitting = true; app.quit(); } },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(trayItems));

  if (isMac) {
    // macOS always has a menu bar at the top of the screen, so keep a normal one there.
    const huddleMenu = { label: "Huddle", submenu: huddleMenuTemplate().filter((i) => i.label !== "Quit Huddle" && i.label !== "Developer tools") };
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, huddleMenu, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]));
  } else {
    Menu.setApplicationMenu(null); // no "File Edit View Window" bar: the logo in the title bar opens the Huddle menu
  }
}
// The tray icon gets a red dot while there are unread messages, so you can tell at a glance without opening Huddle.
let trayImages = null;
function setTrayUnread(unread) {
  if (!tray || !trayImages) return;
  tray.setImage(unread ? trayImages.unread : trayImages.normal);
}
function createTray() {
  const img = nativeImage.createFromPath(TRAY_ICON);
  if (img.isEmpty()) return;
  const size = { width: isMac ? 18 : 20, height: isMac ? 18 : 20 };
  const unreadImg = nativeImage.createFromPath(TRAY_ICON_UNREAD);
  trayImages = { normal: img.resize(size), unread: unreadImg.isEmpty() ? img.resize(size) : unreadImg.resize(size) };
  tray = new Tray(trayImages.normal);
  tray.setToolTip("Huddle");
  tray.on("click", showWindow);
}

// ---------- start up ----------
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault()); // nothing here uses <webview>, so nothing may
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    loadSettings();
    // Huddle needs no browser-style permissions beyond copying to the clipboard and going fullscreen.
    const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    createTray();
    applyStartup();
    // Opened by the computer at sign-in with "background" chosen: no splash and no window (needs the tray to get back in).
    startHidden = launchedHidden && settings.launchAtStartup && settings.startInBackground && !!tray;
    initUpdater();
    buildMenus();
    if (!startHidden) showSplash();
    setSplash("Starting…");
    startupUpdate()
      .catch((e) => { console.error("Startup update check failed", e); return "none"; })
      .then((outcome) => {
        if (outcome === "installing") return; // the installer takes over from here
        setSplash("Opening Huddle…");
        if (!win) createWindow();
        app.on("activate", showWindow);
        if (updater) {
          setInterval(() => void updater.check(feedUrl()), UPDATE_CHECK_EVERY_MS).unref();
        }
      });
  });
  app.on("before-quit", () => { quitting = true; });
  app.on("window-all-closed", () => { if (!isMac) app.quit(); });
}
