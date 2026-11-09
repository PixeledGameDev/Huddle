import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { confirmDialog } from "./Dialogs";
import type { BotAccount, ServerDetail } from "./types";

/** The "Bots" section of Account settings: make bots, copy their token, and choose whether other people's servers may add them. */
export function BotSettings({ onError }: { onError: (e: unknown) => void }) {
  const [bots, setBots] = useState<BotAccount[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [token, setToken] = useState<{ botId: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ bots: BotAccount[] }>("/bots").then((r) => setBots(r.bots), onError);
  }, [onError]);
  useEffect(load, [load]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    try { await work(); } catch (e) { onError(e); } finally { setBusy(false); }
  }

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const r = await api<{ bot: BotAccount; token: string }>("/bots", "POST", { username: name, description });
      setToken({ botId: r.bot.id, value: r.token });
      setCreating(false);
      setName("");
      setDescription("");
      load();
    });
  };

  return (
    <div className="stack">
      <h3>Bots</h3>
      <p className="muted">Bots are accounts your own programs sign in to with a token. They can read and send messages in servers they're added to, and answer slash commands.</p>
      {token && (
        <div className="stack tight notice" role="status">
          <strong>Copy this token now. It's only shown once.</strong>
          <div className="bot-token">{token.value}</div>
          <small className="muted">Send it as <code>Authorization: Bot &lt;token&gt;</code>. Anyone with it can act as your bot.</small>
          <div className="row">
            <button type="button" onClick={() => void navigator.clipboard?.writeText(token.value)}>Copy</button>
            <button type="button" onClick={() => setToken(null)}>I've saved it</button>
          </div>
        </div>
      )}
      {bots === null ? <p className="muted">Loading…</p> : (
        <ul className="bot-list">
          {bots.map((b) => (
            <li key={b.id} className="bot-card">
              <header>
                <strong>{b.displayName ?? b.username}</strong>
                <em className="tag bot-badge">BOT</em>
                <small className="muted">@{b.username} · in {b.servers} {b.servers === 1 ? "server" : "servers"}</small>
              </header>
              {b.description && <small className="muted">{b.description}</small>}
              <label className="row">
                <input type="checkbox" checked={b.public} disabled={busy} onChange={(e) => void act(async () => { await api(`/bots/${b.id}`, "PATCH", { public: e.target.checked }); load(); })} />
                <span>Public: anyone who manages a server can add this bot</span>
              </label>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => void act(async () => {
                  if (!await confirmDialog(`Make a new token for ${b.username}? The old one stops working right away.`)) return;
                  const r = await api<{ token: string }>(`/bots/${b.id}/token`, "POST");
                  setToken({ botId: b.id, value: r.token });
                  load();
                })}>New token…</button>
                <button type="button" className="danger" disabled={busy} onClick={() => void act(async () => {
                  if (!await confirmDialog(`Delete ${b.username}? It leaves every server and can't be brought back.`)) return;
                  await api(`/bots/${b.id}`, "DELETE");
                  setToken((t) => (t?.botId === b.id ? null : t));
                  load();
                })}>Delete…</button>
              </div>
            </li>
          ))}
          {bots.length === 0 && !creating && <li className="muted">You don't have any bots yet.</li>}
        </ul>
      )}
      {creating ? (
        <form className="stack" onSubmit={create}>
          <label>Bot name<input value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9_]{3,20}" title="3–20 letters, numbers or underscores" required /></label>
          <label>What it does (optional)<input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} /></label>
          <div className="row">
            <button type="button" onClick={() => setCreating(false)}>Cancel</button>
            <button className="primary" disabled={busy}>Create bot</button>
          </div>
        </form>
      ) : (
        <div className="row"><button type="button" onClick={() => setCreating(true)}>Create a bot…</button></div>
      )}
    </div>
  );
}

/** Server settings → Bots: the bots already here, and a way to add one of yours or a public one. */
export function ServerBotsTab({ server, onError }: { server: ServerDetail; onError: (e: unknown) => void }) {
  const [mine, setMine] = useState<BotAccount[]>([]);
  const [found, setFound] = useState<BotAccount[]>([]);
  const [term, setTerm] = useState("");
  const [msg, setMsg] = useState("");
  const here = new Set(server.members.filter((m) => m.bot).map((m) => m.id));

  useEffect(() => { api<{ bots: BotAccount[] }>("/bots").then((r) => setMine(r.bots), onError); }, [onError]);
  useEffect(() => {
    const t = setTimeout(() => { api<{ bots: BotAccount[] }>(`/bots/public?q=${encodeURIComponent(term)}`).then((r) => setFound(r.bots), onError); }, 250);
    return () => clearTimeout(t);
  }, [term, onError]);

  async function add(b: BotAccount) {
    try {
      await api(`/servers/${server.id}/bots`, "POST", { botId: b.id });
      setMsg(`${b.username} was added.`);
    } catch (e) { onError(e); }
  }

  const row = (b: BotAccount) => (
    <li key={b.id} className="bot-card">
      <header>
        <strong>{b.displayName ?? b.username}</strong><em className="tag bot-badge">BOT</em>
        <small className="muted">@{b.username}{b.owner ? ` · by ${b.owner}` : ""}</small>
      </header>
      {b.description && <small className="muted">{b.description}</small>}
      <div className="row">{here.has(b.id) ? <small className="muted">Already in this server</small> : <button type="button" className="primary" onClick={() => void add(b)}>Add to {server.name}</button>}</div>
    </li>
  );
  const mineIds = new Set(mine.map((b) => b.id));

  return (
    <div className="stack">
      <h3>Bots</h3>
      {msg && <p className="notice" role="status">{msg} Give it a role in the Roles tab to control what it can do.</p>}
      <p className="muted">{here.size} {here.size === 1 ? "bot is" : "bots are"} in this server. Remove one like any member, with kick.</p>
      {mine.length > 0 && <><strong>Your bots</strong><ul className="bot-list">{mine.map(row)}</ul></>}
      <strong>Public bots</strong>
      <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search by name" maxLength={40} aria-label="Search public bots" />
      <ul className="bot-list">
        {found.filter((b) => !mineIds.has(b.id)).map(row)}
        {found.filter((b) => !mineIds.has(b.id)).length === 0 && <li className="muted">No public bots found.</li>}
      </ul>
    </div>
  );
}
