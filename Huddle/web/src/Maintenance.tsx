import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Logo } from "./Logo";

export interface MaintenanceState { active: boolean; endsAt: string | null; startedAt: string | null; message: string | null; now?: string; build?: string }
const OFF: MaintenanceState = { active: false, endsAt: null, startedAt: null, message: null };

/** Tells every piece of the app that maintenance may have started or stopped, so they all look again right away. */
export const pokeMaintenance = () => window.dispatchEvent(new Event("huddle:maintenance"));

/** Whether Huddle is in maintenance, checked every few seconds. `skew` lets countdowns follow the server's clock, not the computer's. */
export function useMaintenance() {
  const [state, setState] = useState<MaintenanceState>(OFF);
  const [skew, setSkew] = useState(0);
  const wasActive = useRef(false);
  const loadedBuild = useRef<string | null>(null); // the version this page started with
  const [newBuild, setNewBuild] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const m = await api<MaintenanceState>("/maintenance");
      // Only change state when something actually changed: this runs every few seconds, and a new object each time re-rendered the whole app.
      if (m.now) { const skewNow = new Date(m.now).getTime() - Date.now(); setSkew((s) => (Math.abs(s - skewNow) > 2000 ? skewNow : s)); }
      setState((cur) => (cur.active === m.active && cur.endsAt === m.endsAt && cur.message === m.message && cur.startedAt === m.startedAt ? cur : m));
      wasActive.current = m.active;
      if (m.build && m.build !== "dev") {
        loadedBuild.current ??= m.build;
        if (m.build !== loadedBuild.current) setNewBuild(true);
      }
    } catch { /* offline or restarting: keep what we know */ }
  }, []);
  useEffect(() => {
    void refresh();
    window.addEventListener("huddle:maintenance", refresh);
    const t = window.setInterval(refresh, state.active ? 5000 : 20000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); }; // look right away when coming back to the tab
    document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("huddle:maintenance", refresh); document.removeEventListener("visibilitychange", visible); clearInterval(t); };
  }, [refresh, state.active]);
  return { state, skew, refresh, newBuild };
}

/** Milliseconds left, ticking once a second. */
export function useRemaining(endsAt: string | null, skew: number, onDone?: () => void) {
  const [left, setLeft] = useState(() => (endsAt ? new Date(endsAt).getTime() - (Date.now() + skew) : 0));
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!endsAt) return;
    const end = new Date(endsAt).getTime();
    const tick = () => {
      const l = end - (Date.now() + skew);
      setLeft(Math.max(0, l));
      if (l <= 0) { clearInterval(t); done.current?.(); }
    };
    const t = window.setInterval(tick, 1000);
    tick();
    return () => clearInterval(t);
  }, [endsAt, skew]);
  return left;
}

export function fmtCountdown(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`;
}

/** Shown instead of Huddle to everyone except Huddle Admins while maintenance is on. */
export function MaintenanceScreen({ state, skew, signedIn, onAdminSignIn, onSignOut, onDone }: {
  state: MaintenanceState; skew: number; signedIn: boolean; onAdminSignIn: () => void; onSignOut: () => void; onDone: () => void;
}) {
  const left = useRemaining(state.endsAt, skew, onDone);
  const total = state.startedAt && state.endsAt ? new Date(state.endsAt).getTime() - new Date(state.startedAt).getTime() : 0;
  const pct = total > 0 ? Math.min(100, Math.max(0, 100 - (left / total) * 100)) : 0;
  const ends = state.endsAt ? new Date(state.endsAt) : null;
  return (
    <main className="auth maint">
      <section className="maint-card" role="status" aria-live="polite">
        <Logo className="maint-mark" />
        <span className="lp-eyebrow">Maintenance</span>
        <h1>We&rsquo;ll be right back</h1>
        <p className="muted">Huddle is down for a little while so we can make it better.{signedIn ? " You\u2019ll be back in automatically." : ""}</p>
        {state.message && <p className="maint-note">{state.message}</p>}
        <div className="maint-clock" aria-label={`About ${fmtCountdown(left)} left`}>{fmtCountdown(left)}</div>
        <div className="maint-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>
        {ends && <small className="muted">Expected back around {ends.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>}
        <div className="maint-foot">
          {signedIn ? <button type="button" className="link" onClick={onSignOut}>Sign out</button> : <button type="button" className="link" onClick={onAdminSignIn}>Huddle Admin sign in</button>}
        </div>
      </section>
    </main>
  );
}

/** A small reminder for Huddle Admins, who can still use Huddle while it's in maintenance for everyone else. */
export function MaintenancePill({ state, skew }: { state: MaintenanceState; skew: number }) {
  const left = useRemaining(state.endsAt, skew);
  return <div className="maint-pill" role="status"><span className="lp-live" aria-hidden="true" /> Maintenance is on for everyone else · {fmtCountdown(left)} left</div>;
}

/** Offers a reload when Huddle has been updated since this page loaded. Never reloads by itself, so nothing you're typing is lost. */
export function SiteUpdateBanner() {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <span className="lp-live" aria-hidden="true" />
      <span>Huddle was updated. Reload to get the latest version.</span>
      <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
      <button type="button" className="icon ghost" aria-label="Dismiss" onClick={() => setHidden(true)}>✕</button>
    </div>
  );
}
