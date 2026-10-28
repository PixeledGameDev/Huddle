// A reply popup is a sandboxed page. It may show what the main process gives it, and report what the person did with it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huddleToast", {
  onShow: (cb) => {
    ipcRenderer.on("toast:show", (_e, t) => cb({ title: String(t?.title ?? "").slice(0, 100), body: String(t?.body ?? "").slice(0, 250), canReply: !!t?.canReply }));
    ipcRenderer.send("toast:ready");
  },
  reply: (text) => ipcRenderer.invoke("toast:reply", String(text ?? "").slice(0, 2000)),
  markRead: () => ipcRenderer.send("toast:markread"),
  open: () => ipcRenderer.send("toast:open"),
  close: () => ipcRenderer.send("toast:close"),
  hold: (on) => ipcRenderer.send("toast:hold", !!on), // keep it open while the person is typing or pointing at it
});
