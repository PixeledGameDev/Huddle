// Runs in a sandbox with contextIsolation: the page gets only the small, fixed set of functions below.
// The main process checks who is calling before doing anything with them.
const { contextBridge, ipcRenderer } = require("electron");

const version = (process.argv.find((a) => a.startsWith("--huddle-version=")) ?? "").split("=")[1] ?? "";

contextBridge.exposeInMainWorld("huddleDesktop", {
  isDesktop: true,
  platform: process.platform,
  // Present from desktop 1.2: Huddle draws its own title bar instead of the system one.
  titleBar: {
    height: 40,
    openMenu: (x, y) => ipcRenderer.send("menu:popup", { x, y }),
    setColors: (color, symbolColor) => ipcRenderer.send("titlebar:colors", { color, symbolColor }),
  },
  version,
  notify: (n) => ipcRenderer.send("notify", n),
  setBadge: (count, iconDataUrl) => ipcRenderer.send("badge", { count, iconDataUrl }),
  // Automatic updates (see update.js). The page may only read the state, ask for a check, or restart to install.
  getUpdateState: () => ipcRenderer.invoke("update:state"),
  onUpdateState: (cb) => {
    const handler = (_event, state) => cb(state);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.send("update:install"),
  // Present from desktop 1.3: whether Huddle opens with the computer, and whether it shows its window when it does.
  getStartup: () => ipcRenderer.invoke("startup:get"),
  setStartup: (v) => ipcRenderer.invoke("startup:set", v),
  // Present from desktop 1.4: replying to, and marking read, a message straight from its popup.
  onNotificationReply: (cb) => {
    const handler = (_event, r) => cb(r);
    ipcRenderer.on("notification-reply", handler);
    return () => ipcRenderer.removeListener("notification-reply", handler);
  },
  replyResult: (id, ok, error) => ipcRenderer.send("reply-result", { id, ok, error }),
  onNotificationMarkRead: (cb) => {
    const handler = (_event, target) => cb(target);
    ipcRenderer.on("notification-markread", handler);
    return () => ipcRenderer.removeListener("notification-markread", handler);
  },
  // Present from desktop 1.7: lets the app keep notifications working while the page is unloaded to save memory.
  getUpdateInfo: () => ipcRenderer.invoke("update-info"),
  syncNotifyPrefs: (prefs) => ipcRenderer.send("notify-prefs", prefs),
  pageReady: () => ipcRenderer.send("page-ready"),
  onNotificationClick: (cb) => {
    const handler = (_event, target) => cb(target);
    ipcRenderer.on("notification-click", handler);
    return () => ipcRenderer.removeListener("notification-click", handler);
  },
});

// Used only by the app's own setup / error page (the main process refuses these from anywhere else).
contextBridge.exposeInMainWorld("huddleSetup", {
  current: () => ipcRenderer.invoke("setup:current"),
  save: (url) => ipcRenderer.invoke("setup:save", url),
  retry: () => ipcRenderer.send("setup:retry"),
  changeServer: () => ipcRenderer.send("setup:change"),
});
