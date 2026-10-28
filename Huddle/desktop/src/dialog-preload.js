// The popup window is a sandboxed page. It may only receive what to show, say which button was pressed, and report its height.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("huddleDialog", {
  onShow: (cb) => {
    ipcRenderer.on("dialog:show", (_e, o) => cb(o));
    ipcRenderer.send("dialog:ready");
  },
  choose: (index) => ipcRenderer.send("dialog:choose", index),
  resize: (height) => ipcRenderer.send("dialog:size", height),
});
