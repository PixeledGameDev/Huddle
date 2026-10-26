import { useEffect, useState } from "react";

/** Desktop-app-only settings: opening with the computer, and whether the window shows when it does. Hidden in a browser and in older desktop apps. */
export function DesktopSettings() {
  const bridge = window.huddleDesktop;
  const [s, setS] = useState<{ supported: boolean; launch: boolean; background: boolean } | null>(null);
  useEffect(() => {
    bridge?.getStartup?.().then((v) => setS(v), () => {});
  }, [bridge]);
  if (!bridge?.setStartup || !s) return null;

  const change = async (patch: Partial<{ launch: boolean; background: boolean }>) => {
    const next = { launch: s.launch, background: s.background, ...patch };
    setS({ ...s, ...next }); // show the change straight away
    const saved = await bridge.setStartup!(next).catch(() => null);
    if (saved) setS(saved);
  };

  return (
    <div className="stack">
      <h3>Startup</h3>
      <label className="check">
        <input type="checkbox" checked={s.launch} disabled={!s.supported} onChange={(e) => void change({ launch: e.target.checked })} /> Open Huddle when I sign in to my computer
      </label>
      <fieldset className="stack tight" disabled={!s.launch || !s.supported}>
        <label className="check">
          <input type="radio" name="startup-mode" checked={!s.background} onChange={() => void change({ background: false })} /> Show the Huddle window
        </label>
        <label className="check">
          <input type="radio" name="startup-mode" checked={s.background} onChange={() => void change({ background: true })} /> Open quietly in the background (find it in the tray)
        </label>
      </fieldset>
      {!s.supported && <small className="hint">This only works in the installed app, not a development copy.</small>}
    </div>
  );
}
