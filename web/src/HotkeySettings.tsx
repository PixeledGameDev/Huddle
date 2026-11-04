import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { acceleratorFromEvent, formatAccelerator, type DesktopHotkeys, type HotkeyAction, type HotkeyStatus } from "./hotkeys";

const ROWS: { id: HotkeyAction; label: string; hint: string }[] = [
  { id: "toggle", label: "Show or hide Huddle", hint: "Brings Huddle to the front, or sends it to the tray" },
  { id: "switcher", label: "Quick switcher", hint: "Opens Huddle with the Ctrl+K search ready" },
  { id: "unread", label: "Jump to next unread", hint: "Opens the next direct message or mention" },
];

const PROBLEM: Partial<Record<HotkeyStatus, string>> = {
  taken: "Another program is already using this shortcut. Pick a different one.",
  invalid: "That combination can't be used.",
  duplicate: "Another action here already uses this shortcut.",
};

/** Settings → Desktop app → Keyboard shortcuts: keys that work from any program, even while Huddle is hidden in the tray. */
export function HotkeySettings() {
  const bridge = window.huddleDesktop;
  const [state, setState] = useState<DesktopHotkeys | null>(null);
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const [hint, setHint] = useState("");

  useEffect(() => {
    bridge?.getHotkeys?.().then((v) => setState(v), () => {});
  }, [bridge]);

  async function save(action: HotkeyAction, accelerator: string) {
    if (!state) return;
    const next = { ...state.hotkeys, [action]: accelerator };
    setState({ ...state, hotkeys: next }); // show it straight away
    const saved = await bridge?.setHotkeys?.(next).catch(() => null);
    if (saved) setState(saved);
  }

  // While choosing, the keys go here instead of triggering the shortcuts that exist now.
  useEffect(() => {
    if (!recording) return;
    bridge?.pauseHotkeys?.(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const c = acceleratorFromEvent(e);
      if ("accelerator" in c) {
        void save(recording, c.accelerator);
        setRecording(null);
      } else if (c.problem === "cancel") setRecording(null);
      else if (c.problem === "clear") {
        void save(recording, "");
        setRecording(null);
      } else if (c.problem === "needs-modifier") setHint("Hold Ctrl, Alt or the Windows key while you press it.");
      else if (c.problem === "unsupported") setHint("That key can't be used in a shortcut.");
    };
    const cancel = () => setRecording(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      bridge?.pauseHotkeys?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  if (!state) return null;
  if (!state.supported) {
    return (
      <>
        <h3>Keyboard shortcuts</h3>
        <small className="muted">Shortcuts that work from any program aren't available on this system.</small>
      </>
    );
  }
  return (
    <>
      <h3>Keyboard shortcuts</h3>
      <small className="muted">These work from any program, even while Huddle is hidden in the tray. Each needs Ctrl, Alt or the Windows key.</small>
      {ROWS.map((r) => {
        const value = state.hotkeys[r.id];
        const status = state.status[r.id];
        const active = recording === r.id;
        return (
          <div className="hotkey-row" key={r.id}>
            <div>
              <strong>{r.label}</strong>
              <small className="muted">{r.hint}</small>
            </div>
            <div className="hotkey-ctl">
              <button type="button" className={active ? "pill on" : "pill"} onClick={() => { setHint(""); setRecording(active ? null : r.id); }}>
                {active ? "Press the keys…" : value ? formatAccelerator(value) : "Not set"}
              </button>
              {value && !active && (
                <button type="button" className="icon ghost" aria-label={`Clear the ${r.label} shortcut`} onClick={() => void save(r.id, "")}>
                  <Icon name="close" />
                </button>
              )}
            </div>
            {active && <small className="hotkey-msg muted">{hint || "Press the keys you want to use. Esc cancels, Backspace clears."}</small>}
            {!active && value && status === "ok" && <small className="hotkey-msg saved"><Icon name="check" /> Active</small>}
            {!active && value && PROBLEM[status] && <small className="hotkey-msg hint">{PROBLEM[status]}</small>}
          </div>
        );
      })}
    </>
  );
}
