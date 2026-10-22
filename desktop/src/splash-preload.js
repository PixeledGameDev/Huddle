// The splash screen is a sandboxed page. All it may do is receive status text from the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huddleSplash", {
  onStatus: (cb) => {
    ipcRenderer.on("splash:status", (_e, s) => cb({ text: typeof s?.text === "string" ? s.text.slice(0, 120) : "", percent: Number.isFinite(s?.percent) ? s.percent : undefined }));
    ipcRenderer.send("splash:ready");
  },
});
