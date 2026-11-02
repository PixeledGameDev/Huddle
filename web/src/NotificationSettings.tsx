import { useState } from "react";
import { loadNotifyPrefs, permissionState, requestPermission, saveNotifyPrefs, sendTestNotification, type NotifyFlag, type NotifyPrefs, type Permission } from "./notify";
import { isQuiet } from "./quiet";

/** The "Notifications" section of Profile & appearance. */
export function NotificationSettings() {
  const [p, setP] = useState<NotifyPrefs>(loadNotifyPrefs());
  const [perm, setPerm] = useState<Permission>(permissionState());
  const desktop = !!window.huddleDesktop;

  const update = (patch: Partial<NotifyPrefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    saveNotifyPrefs(next);
  };
  const box = (key: NotifyFlag, label: string, disabled = false) => (
    <label className="check">
      <input type="checkbox" checked={p[key]} disabled={disabled} onChange={(e) => update({ [key]: e.target.checked })} /> {label}
    </label>
  );

  return (
    <div className="stack">
      <h3>Notifications</h3>
      {box("enabled", "Notify me about messages meant for me")}
      <fieldset className="stack tight" disabled={!p.enabled}>
        {box("dms", "Direct messages")}
        {box("mentions", "When someone @mentions me")}
        {box("everyone", "When someone uses @everyone")}
        {box("sound", "Play a sound")}
        {box("preview", "Show message text in notifications")}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={p.quiet.enabled} onChange={(e) => update({ quiet: { ...p.quiet, enabled: e.target.checked } })} /> Quiet hours: no popups or sounds during these times
      </label>
      <fieldset className="stack tight" disabled={!p.quiet.enabled}>
        <div className="row">
          <label>From <input type="time" value={p.quiet.from} onChange={(e) => update({ quiet: { ...p.quiet, from: e.target.value || p.quiet.from } })} /></label>
          <label>to <input type="time" value={p.quiet.to} onChange={(e) => update({ quiet: { ...p.quiet, to: e.target.value || p.quiet.to } })} /></label>
        </div>
        <small className="muted">Messages still count as unread and show on badges. {isQuiet(p.quiet) && "Quiet hours are active right now."}</small>
      </fieldset>
      {!desktop && perm === "default" && (
        <button type="button" onClick={async () => setPerm(await requestPermission())}>Allow notifications in this browser</button>
      )}
      {!desktop && perm === "denied" && <p className="muted">Notifications are blocked for this site. Allow them in your browser's site settings, then reload.</p>}
      {perm === "unsupported" && <p className="muted">This browser doesn't support notifications.</p>}
      <div className="row">
        <button type="button" onClick={sendTestNotification} disabled={!p.enabled || perm === "unsupported" || perm === "denied"}>Send a test</button>
      </div>
      <p className="muted">You get notifications while Huddle is open in a tab or running in the desktop app, and only when it isn't the window you're looking at.{!desktop && <> The <a href="/download" target="_blank" rel="noopener">desktop app</a> keeps running in the tray, so they still arrive when your browser is closed.</>}</p>
    </div>
  );
}
