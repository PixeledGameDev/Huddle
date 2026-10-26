import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Modal } from "./Modals";

export interface Suggestion {
  id: string;
  title: string;
  body: string;
  status: string;
  author: string;
  mine: boolean;
  votes: number;
  voted: boolean;
  createdAt: string;
}

const STATUS_LABEL: Record<string, string> = { open: "Open", planned: "Planned", in_progress: "In progress", done: "Done", declined: "Declined" };

/** The suggestions board: propose an idea for Huddle, vote on others'. Huddle Admins also set each idea's status. */
export function SuggestionsModal({ admin, onClose, onNotice, onError }: { admin: boolean; onClose: () => void; onNotice: (text: string) => void; onError: (e: unknown) => void }) {
  const [tab, setTab] = useState<"active" | "closed">("active");
  const [sort, setSort] = useState<"top" | "new">("top");
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ suggestions: Suggestion[] }>(`/suggestions?tab=${tab === "closed" ? "closed" : "active"}&sort=${sort}`).then((r) => setItems(r.suggestions), onError);
  }, [tab, sort, onError]);
  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/suggestions", "POST", { title, body });
      setTitle("");
      setBody("");
      setComposing(false);
      setTab("active");
      setSort("new");
      onNotice("Thanks! Your suggestion is on the board.");
      load();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  async function vote(s: Suggestion) {
    // show the change straight away; the server's answer corrects it if needed
    setItems((list) => list?.map((x) => (x.id === s.id ? { ...x, voted: !s.voted, votes: x.votes + (s.voted ? -1 : 1) } : x)) ?? null);
    try {
      const r = await api<{ votes: number; voted: boolean }>(`/suggestions/${s.id}/vote`, s.voted ? "DELETE" : "PUT");
      setItems((list) => list?.map((x) => (x.id === s.id ? { ...x, ...r } : x)) ?? null);
    } catch (err) {
      onError(err);
      load();
    }
  }

  async function setStatus(s: Suggestion, status: string) {
    try {
      await api(`/suggestions/${s.id}`, "PATCH", { status });
      load(); // it may now belong on the other tab
    } catch (err) {
      onError(err);
    }
  }

  async function remove(s: Suggestion) {
    if (!window.confirm(`Remove "${s.title}"?`)) return;
    try {
      await api(`/suggestions/${s.id}`, "DELETE");
      setItems((list) => list?.filter((x) => x.id !== s.id) ?? null);
    } catch (err) {
      onError(err);
    }
  }

  return (
    <Modal title="Suggestions" onClose={onClose}>
      <p className="muted">Got an idea to make Huddle better? Post it here, and vote for the ones you'd like most.</p>

      {composing ? (
        <form className="stack suggest-form" onSubmit={submit}>
          <label>
            Your idea
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="A short title" autoFocus required />
          </label>
          <label>
            Details (optional)
            <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} rows={4} placeholder="What would it do, and why would it help?" />
          </label>
          <div className="row">
            <button type="button" onClick={() => setComposing(false)}>Cancel</button>
            <button className="primary" disabled={busy || title.trim().length < 3}>Post suggestion</button>
          </div>
        </form>
      ) : (
        <button className="primary" onClick={() => setComposing(true)}>Suggest something</button>
      )}

      <div className="suggest-bar">
        <div className="seg" role="tablist" aria-label="Show">
          <button role="tab" aria-selected={tab === "active"} className={tab === "active" ? "on" : ""} onClick={() => setTab("active")}>Open ideas</button>
          <button role="tab" aria-selected={tab === "closed"} className={tab === "closed" ? "on" : ""} onClick={() => setTab("closed")}>Done &amp; declined</button>
        </div>
        <label className="sort">
          Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as "top" | "new")}>
            <option value="top">Most votes</option>
            <option value="new">Newest</option>
          </select>
        </label>
      </div>

      {items === null ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted">{tab === "active" ? "Nothing here yet. Be the first to suggest something!" : "Nothing has been finished or declined yet."}</p>
      ) : (
        <ul className="suggest-list">
          {items.map((s) => (
            <li key={s.id} className="suggest-item">
              <button className={s.voted ? "vote on" : "vote"} aria-pressed={s.voted} aria-label={`${s.voted ? "Remove your vote from" : "Vote for"} ${s.title}`} onClick={() => vote(s)}>
                <span aria-hidden="true">▲</span>
                <strong>{s.votes}</strong>
              </button>
              <div className="suggest-main">
                <div className="suggest-title">
                  <strong>{s.title}</strong>
                  {s.status !== "open" && <span className={`status ${s.status}`}>{STATUS_LABEL[s.status]}</span>}
                </div>
                {s.body && <p className="suggest-body">{s.body}</p>}
                <small className="muted">
                  {s.mine ? "You" : s.author} · {new Date(s.createdAt).toLocaleDateString()}
                </small>
                {(admin || s.mine) && (
                  <div className="suggest-tools">
                    {admin && (
                      <select aria-label={`Status of ${s.title}`} value={s.status} onChange={(e) => setStatus(s, e.target.value)}>
                        {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    )}
                    <button className="icon danger" onClick={() => remove(s)}>Remove</button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
