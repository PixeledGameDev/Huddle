import { useEffect, useState } from "react";

/** In the desktop app: tells you when a new version has downloaded and lets you restart to install it. */
export function UpdateBanner() {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const d = window.huddleDesktop;
    if (!d?.onUpdateState) return;
    void d.getUpdateState?.().then((s) => s && setState(s), () => {});
    return d.onUpdateState((s) => { setState(s); if (s.status === "ready") setHidden(false); });
  }, []);
  if (!state || hidden || state.status !== "ready") return null;
  return (
    <div className="notice-bar update-bar" role="status">
      <span>Huddle {state.version} has been downloaded. Restart to finish updating.</span>
      <span className="row-actions">
        <button className="primary" onClick={() => window.huddleDesktop?.installUpdate?.()}>Restart now</button>
        <button onClick={() => setHidden(true)}>Later</button>
      </span>
    </div>
  );
}
