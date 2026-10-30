import { Modal } from "./Modals";
import { CHANGELOG, entriesSince } from "./changelog";

const MAX_SHOWN = 6;

/** Shown once after Huddle has changed since you last looked: just what's new, not the whole history. */
export default function WhatsNew({ since, desktopVersion, onClose, onAll }: { since: string | null; desktopVersion?: string | null; onClose: () => void; onAll: () => void }) {
  const entries = entriesSince(since);
  // The desktop app just updated but the website hasn't changed since you last looked: show the latest desktop changes instead of nothing.
  if (!entries.length && desktopVersion) entries.push(...CHANGELOG.filter((e) => e.desktop).slice(0, 3));
  const shown = entries.slice(0, MAX_SHOWN);
  const hidden = Math.max(entries.length - shown.length, 0);
  return (
    <Modal title="What's new in Huddle" onClose={onClose}>
      <div className="changelog">
        <p className="muted">{desktopVersion ? `The Huddle desktop app just updated to version ${desktopVersion}.` : "Huddle got better since you were last here."}</p>
        {shown.map((e, i) => (
          <section key={e.version} className="log-entry">
            <header>
              <h3>{e.title}</h3>
              <span className="muted">v{e.version}</span>
              {i === 0 && entries.length > 0 && <em className="tag">Latest</em>}
            </header>
            <ul>{e.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          </section>
        ))}
        {hidden > 0 && <p className="muted">…and {hidden} more {hidden === 1 ? "update" : "updates"}.</p>}
        <div className="whatsnew-actions">
          <button type="button" className="link" onClick={onAll}>See all updates ({CHANGELOG.length})</button>
          <button type="button" className="primary" onClick={onClose} autoFocus>Got it</button>
        </div>
      </div>
    </Modal>
  );
}
