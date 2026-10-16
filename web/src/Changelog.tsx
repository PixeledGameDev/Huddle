import { Modal } from "./Modals";
import { CHANGELOG } from "./changelog";

export default function ChangelogModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="What's new" onClose={onClose}>
      <div className="changelog">
        {CHANGELOG.map((e, i) => (
          <section key={e.version} className="log-entry">
            <header>
              <h3>{e.title}</h3>
              <span className="muted">
                v{e.version} · {new Date(`${e.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}
              </span>
              {i === 0 && <em className="tag">Latest</em>}
            </header>
            <ul>{e.changes.map((c) => <li key={c}>{c}</li>)}</ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
