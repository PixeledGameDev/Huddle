import { useEffect, useState } from "react";

/** Desktop-app-only settings: opening with the computer, and whether the window shows when it does. Hidden in a browser and in older desktop apps. */
export function DesktopSettings() {
  const bridge = window.huddleDesktop;
  const [s, setS] = useState<{ supported: boolean; launch: boolean; background: boolean } | null>(null);
  const [idle, setIdle] = useState<DesktopIdleSettings | null>(null);
  useEffect(() => {
    bridge?.getStartup?.().then((v) => setS(v), () => {});
    bridge?.getIdleSettings?.().then((v) => setIdle(v), () => {});
  }, [bridge]);
  if (!bridge?.setStartup || !s) return null;

  const change = async (patch: Partial<{ launch: boolean; background: boolean }>) => {
    const next = { launch: s.launch, background: s.background, ...patch };
    setS({ ...s, ...next }); // show the change straight away
    const saved = await bridge.setStartup!(next).catch(() => null);
    if (saved) setS(saved);
  };

  const changeIdle = async (patch: Partial<{ enabled: boolean; minutes: number }>) => {
    if (!idle) return;
    const next = { enabled: idle.enabled, minutes: idle.minutes, ...patch };
    setIdle({ ...idle, ...next }); // show the change straight away
    const saved = await bridge.setIdleSettings?.(next).catch(() => null);
    if (saved) setIdle(saved);
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
      {idle && (
        <>
          <h3>Status</h3>
          <label className="check">
            <input type="checkbox" checked={idle.enabled} onChange={(e) => void changeIdle({ enabled: e.target.checked })} /> Show me as Idle when I'm away from my computer
          </label>
          <fieldset className="stack tight" disabled={!idle.enabled}>
            <label>
              After{" "}
              <select value={idle.minutes} onChange={(e) => void changeIdle({ minutes: Number(e.target.value) })}>
                {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m === 60 ? "1 hour" : `${m} minutes`}</option>)}
              </select>{" "}
              without using the keyboard or mouse, or when the screen is locked
            </label>
            <small className="muted">Only applies when your status is Online, and only if none of your other devices are active. Your chosen status never changes.</small>
          </fieldset>
        </>
      )}
    </div>
  );
}
