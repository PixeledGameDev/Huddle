import { useEffect, useState } from "react";
import { api } from "./api";
import type { ServerDetail, ServerSummary, Settings } from "./types";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button className="icon" aria-label="Close" onClick={onClose}>✕</button></header>
        {children}
      </div>
    </div>
  );
}

export function AddServerModal({ onClose, onDone, onError }: { onClose: () => void; onDone: (s: ServerSummary) => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  return (
    <Modal title="Add a server" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try { onDone((await api<{ server: ServerSummary }>("/servers", "POST", { name })).server); } catch (err) { onError(err); }
        }}
      >
        <label>Create your own<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Server name" maxLength={40} required /></label>
        <button className="primary">Create server</button>
      </form>
      <hr />
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try { onDone((await api<{ server: ServerSummary }>("/join", "POST", { code })).server); } catch (err) { onError(err); }
        }}
      >
        <label>Join with an invite code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" required /></label>
        <button className="primary">Join server</button>
      </form>
    </Modal>
  );
}

type Opt = [number, string];
const DURATIONS: Opt[] = [[60, "1 minute"], [300, "5 minutes"], [600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"], [86400, "1 day"], [604800, "1 week"]];
const WINDOWS: Opt[] = [[30, "30 seconds"], [60, "1 minute"], [120, "2 minutes"], [300, "5 minutes"]];
const COOLDOWNS: Opt[] = [[0, "None"], [60, "1 minute"], [300, "5 minutes"], [900, "15 minutes"], [3600, "1 hour"]];
const MIN_AGE: Opt[] = [[0, "Anyone"], [600, "10 minutes"], [3600, "1 hour"], [86400, "1 day"]];
const THRESHOLDS: Opt[] = [[51, "Majority (51%)"], [60, "60%"], [67, "Two thirds (67%)"], [75, "75%"], [100, "Everyone"]];
const MIN_VOTES: Opt[] = [[2, "2 votes"], [3, "3 votes"], [5, "5 votes"], [10, "10 votes"]];

function Select({ label, value, options, onChange, hint }: { label: string; value: number; options: Opt[]; onChange: (n: number) => void; hint?: string }) {
  const opts = options.some(([v]) => v === value) ? options : [...options, [value, String(value)] as Opt];
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {opts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

const AUDIT_TEXT: Record<string, (e: any) => string> = {
  "vote.start": (e) => `${e.actor} started a vote on ${e.target}`,
  "vote.passed": (e) => `Vote on ${e.target} passed (${e.detail?.action})`,
  "vote.failed": (e) => `Vote on ${e.target} failed`,
  "settings.update": (e) => `${e.actor} changed server settings`,
  "role.update": (e) => `${e.actor} set ${e.target} to ${e.detail?.role}`,
};

export function SettingsModal({ server, onClose, onSaved, onError }: { server: ServerDetail; onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [s, setS] = useState<Settings>(server.settings);
  const [audit, setAudit] = useState<any[]>([]);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    api<{ entries: any[] }>(`/servers/${server.id}/audit`).then((r) => setAudit(r.entries)).catch(onError);
  }, [server.id]);

  return (
    <Modal title={`${server.name} settings`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api(`/servers/${server.id}/settings`, "PATCH", s);
            onSaved();
          } catch (err) { onError(err); }
        }}
      >
        <h3>Vote moderation</h3>
        <label className="check">
          <input type="checkbox" checked={s.voteEnabled} onChange={(e) => set("voteEnabled", e.target.checked)} />
          Let members vote to remove disruptive people
        </label>
        <fieldset disabled={!s.voteEnabled} className="grid">
          <label>
            When a vote passes
            <select value={s.voteAction} onChange={(e) => set("voteAction", e.target.value as Settings["voteAction"])}>
              <option value="timeout">Time the member out</option>
              <option value="kick">Kick the member</option>
              <option value="ban">Ban the member temporarily</option>
            </select>
          </label>
          {s.voteAction !== "kick" && (
            <Select label={s.voteAction === "ban" ? "Ban length" : "Timeout length"} value={s.voteDurationSeconds} options={DURATIONS} onChange={(n) => set("voteDurationSeconds", n)} />
          )}
          <Select label="Share of online voters needed" value={s.voteThresholdPct} options={THRESHOLDS} onChange={(n) => set("voteThresholdPct", n)} />
          <Select label="Minimum yes votes" value={s.voteMinVotes} options={MIN_VOTES} onChange={(n) => set("voteMinVotes", n)} hint="A vote can't start without this many eligible members online." />
          <Select label="Voting time" value={s.voteWindowSeconds} options={WINDOWS} onChange={(n) => set("voteWindowSeconds", n)} />
          <Select label="Cooldown between votes" value={s.voteCooldownSeconds} options={COOLDOWNS} onChange={(n) => set("voteCooldownSeconds", n)} />
          <Select label="Who can vote" value={s.voteMinMemberAgeSeconds} options={MIN_AGE} onChange={(n) => set("voteMinMemberAgeSeconds", n)} hint="Minimum time in the server. Owners and admins always can." />
        </fieldset>
        <p className="muted">Owners and admins can't be voted on.</p>
        <button className="primary">Save changes</button>
      </form>
      <hr />
      <h3>Recent activity</h3>
      <ul className="audit">
        {audit.length === 0 && <li className="muted">Nothing yet.</li>}
        {audit.map((e) => (
          <li key={e.id}>
            <time>{new Date(e.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</time>
            {(AUDIT_TEXT[e.action] ?? (() => e.action))(e)}
          </li>
        ))}
      </ul>
    </Modal>
  );
}
