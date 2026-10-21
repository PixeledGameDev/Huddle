// Runs in a sandbox with contextIsolation: the page gets only the small, fixed set of functions below.
// The main process checks who is calling before doing anything with them.
const { contextBridge, ipcRenderer } = require("electron");

const version = (process.argv.find((a) => a.startsWith("--huddle-version=")) ?? "").split("=")[1] ?? "";

contextBridge.exposeInMainWorld("huddleDesktop", {
  isDesktop: true,
  platform: process.platform,
  version,
  notify: (n) => ipcRenderer.send("notify", n),
  setBadge: (count, iconDataUrl) => ipcRenderer.send("badge", { count, iconDataUrl }),
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
