import { useEffect, useState } from "react";
import { Modal } from "./Modals";
import type { Message, Poll } from "./types";
import { fmtRemaining } from "./util";

interface CardProps {
  message: Message;
  poll: Poll;
  canClose: boolean;
  timedOut: boolean;
  nameOf: (id: string) => string;
  onVote: (optionIds: string[]) => void;
  onClose: () => void;
}

export function PollCard({ poll, canClose, timedOut, nameOf, onVote, onClose }: CardProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!poll.endsAt || poll.closed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [poll.endsAt, poll.closed]);

  const endMs = poll.endsAt ? new Date(poll.endsAt).getTime() : null;
  const ended = poll.closed || (endMs !== null && endMs <= now);
  const total = Math.max(poll.totalVoters, 1);

  const toggle = (id: string) => {
    const mine = poll.myVotes;
    if (poll.multi) onVote(mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id]);
    else onVote(mine.includes(id) ? [] : [id]);
  };

  return (
    <div className="poll">
      <strong className="poll-q">{poll.question}</strong>
      <small className="muted">{poll.multi ? "Select one or more" : "Select one"}{poll.anonymous ? " · Anonymous" : ""}</small>
      <div className="poll-opts">
        {poll.options.map((o) => {
          const mine = poll.myVotes.includes(o.id);
          return (
            <button
              key={o.id}
              className={mine ? "poll-opt mine" : "poll-opt"}
              disabled={ended || timedOut}
              aria-pressed={mine}
              title={poll.anonymous ? undefined : o.voterIds.map(nameOf).join(", ")}
              onClick={() => toggle(o.id)}
            >
              <span className="poll-bar" style={{ width: `${(o.count / total) * 100}%` }} />
              <span className="poll-text">{mine ? "✓ " : ""}{o.text}</span>
              <span className="poll-count">{o.count}</span>
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <small className="muted">
          {poll.totalVoters} {poll.totalVoters === 1 ? "voter" : "voters"} · {ended ? "Closed" : endMs ? `Closes in ${fmtRemaining(endMs - now)}` : "No end time"}
        </small>
        {canClose && !ended && <button className="link" onClick={onClose}>Close poll</button>}
      </div>
    </div>
  );
}

const DURATIONS: [string, string][] = [["", "No end time"], ["3600", "1 hour"], ["86400", "1 day"], ["259200", "3 days"], ["604800", "7 days"]];

export function PollModal({ channelName, onClose, onCreate }: { channelName: string; onClose: () => void; onCreate: (p: { question: string; options: string[]; multi: boolean; anonymous: boolean; durationSeconds: number | null }) => Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [duration, setDuration] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const clean = options.map((o) => o.trim()).filter(Boolean);
    setBusy(true);
    setError("");
    try {
      await onCreate({ question, options: clean, multi, anonymous, durationSeconds: duration ? Number(duration) : null });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the poll.");
      setBusy(false);
    }
  }

  return (
    <Modal title={`New poll in #${channelName}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label>Question<input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={200} placeholder="What should we play tonight?" autoFocus required /></label>
        <div className="stack tight">
          <strong className="label-text">Options</strong>
          {options.map((o, i) => (
            <div className="opt-row" key={i}>
              <input value={o} maxLength={80} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} onChange={(e) => setOptions((p) => p.map((x, j) => (j === i ? e.target.value : x)))} />
              {options.length > 2 && <button type="button" className="icon" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((p) => p.filter((_, j) => j !== i))}>✕</button>}
            </div>
          ))}
          {options.length < 10 && <button type="button" className="link left" onClick={() => setOptions((p) => [...p, ""])}>+ Add option</button>}
        </div>
        <label className="check"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />Allow multiple choices</label>
        <label className="check"><input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />Anonymous (hide who voted)</label>
        <label>Closes after
          <select value={duration} onChange={(e) => setDuration(e.target.value)}>
            {DURATIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>Create poll</button>
      </form>
    </Modal>
  );
}
