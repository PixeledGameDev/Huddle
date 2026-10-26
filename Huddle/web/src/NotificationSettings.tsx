import { useState } from "react";
import { loadNotifyPrefs, permissionState, requestPermission, saveNotifyPrefs, sendTestNotification, type NotifyPrefs, type Permission } from "./notify";

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
  const box = (key: keyof NotifyPrefs, label: string, disabled = false) => (
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
