/**
 * The text behind "Troubleshooting → Copy debug info": versions, what the app is doing and the last few log lines,
 * ready to paste when asking for help. It holds no messages, passwords or sign-in details, and only the server's host name.
 */
const { redact } = require("./log");

const yesNo = (v) => (v ? "on" : "off");

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "not set";
  }
}

function formatDebugInfo(i) {
  const lines = [
    `Huddle desktop ${i.appVersion}${i.packaged ? "" : " (running from source)"}`,
    `Electron ${i.electron} · Chromium ${i.chrome} · Node ${i.node}`,
    `${i.platform} ${i.arch} · ${i.osVersion}`,
    `Server: ${hostOf(i.serverUrl)}`,
    `Running for: ${Math.round((i.uptimeSeconds ?? 0) / 60)} min`,
  ];
  const u = i.update ?? {};
  lines.push(`Updates: ${u.status ?? "unavailable"}${u.version ? ` (${u.version})` : ""}${u.message ? ` · ${redact(u.message)}` : ""}`);
  if (i.memory) {
    const parts = Object.entries(i.memory.groups).map(([k, v]) => `${k} ${v} MB`).join(", ");
    lines.push(`Memory: about ${i.memory.total} MB (${parts}) · page ${i.memory.pageLoaded ? "loaded" : "unloaded"}`);
  }
  const s = i.settings ?? {};
  lines.push(
    `Settings: tray ${yesNo(s.closeToTray)} · start with computer ${yesNo(s.launchAtStartup)} · start hidden ${yesNo(s.startInBackground)} · ` +
      `free memory when hidden ${yesNo(s.unloadWhenHidden)} · low graphics ${yesNo(s.lowGraphics)}`,
  );
  if (i.crashDumps !== undefined) lines.push(`Crash reports saved: ${i.crashDumps}`);
  const tail = i.logTail ?? [];
  lines.push("", tail.length ? "Recent log:" : "Recent log: (empty)", ...tail);
  return redact(lines.join("\n")).slice(0, 12000);
}

module.exports = { formatDebugInfo, hostOf };
