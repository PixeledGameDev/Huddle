// The small bridge every local page (splash, popups, setup) uses to talk to the app. It is only loaded by the app's own pages,
// and the app checks which window each message comes from before acting on it.
(function () {
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;
  const post = (msg) => window.ipc.postMessage(JSON.stringify(msg));
  window.hd = {
    send: (cmd, args) => post({ cmd, args }),
    invoke: (cmd, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); post({ id, cmd, args }); }),
    on: (name, cb) => { listeners.set(name, cb); },
  };
  window.__resolve = (id, value) => { const r = pending.get(id); if (r) { pending.delete(id); r(value); } };
  window.__emit = (name, payload) => { const cb = listeners.get(name); if (cb) cb(payload); };
})();
