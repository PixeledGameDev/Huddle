import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Modal } from "./Modals";

interface Overview {
  admins: { id: string; username: string; displayName: string | null; locked: boolean }[];
  servers: { id: string; name: string; members: number; channels: { id: string; name: string }[] }[];
  people: number;
  broadcasting: boolean;
  bans: { id: string; username: string; reason: string | null; permanent: boolean; until: string | null }[];
}

const BAN_LENGTHS: [string, string][] = [["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"], ["2592000", "30 days"], ["", "Permanent"]];

/** Only ever opened by Huddle Admins (the server answers everyone else with "not found"). */
export function HuddleAdminModal({ meId, onClose, onNotice, onError }: { meId: string; onClose: () => void; onNotice: (text: string) => void; onError: (e: unknown) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [target, setTarget] = useState<"dms" | "server">("server");
  const [serverId, setServerId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [username, setUsername] = useState("");
  const [who, setWho] = useState("");
  const [action, setAction] = useState<"ban" | "delete">("ban");
  const [banLength, setBanLength] = useState("86400");
  const [reason, setReason] = useState("");
  const [wipeMessages, setWipeMessages] = useState(true);
  const [wipeServers, setWipeServers] = useState(false);
  const [helpWho, setHelpWho] = useState("");
  const [issued, setIssued] = useState<{ username: string; code: string; minutes: number } | null>(null);

  const load = useCallback(() => {
    api<Overview>("/huddle/overview").then((o) => {
      setData(o);
      setServerId((cur) => cur || o.servers[0]?.id || "");
    }, onError);
  }, [onError]);
  useEffect(load, [load]);

  const server = data?.servers.find((s) => s.id === serverId);
  useEffect(() => setChannelId(server?.channels[0]?.id ?? ""), [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!data || sending) return;
    if (target === "dms" && !window.confirm(`Send this to everyone's direct messages (${data.people} people) as Huddle? This can't be undone.`)) return;
    setSending(true);
    try {
      if (target === "dms") {
        const r = await api<{ recipients: number }>("/huddle/send", "POST", { target, content });
        onNotice(`Sending to ${r.recipients} people as Huddle…`);
      } else {
        const r = await api<{ server: string; channel: string }>("/huddle/send", "POST", { target, serverId, channelId, content });
        onNotice(`Sent to #${r.channel} in ${r.server} as Huddle.`);
      }
      setContent("");
      load();
    } catch (err) {
      onError(err);
    } finally {
      setSending(false);
    }
  }

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ username: string }>("/huddle/admins", "POST", { username });
      onNotice(`${r.username} is now a Huddle Admin.`);
      setUsername("");
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function moderate(e: React.FormEvent) {
    e.preventDefault();
    const name = who.trim().replace(/^@/, "");
    try {
      if (action === "ban") {
        const length = banLength ? Number(banLength) : null;
        if (!window.confirm(`Ban @${name} from Huddle ${length ? `for ${BAN_LENGTHS.find(([v]) => v === banLength)![1]}` : "permanently"}? They'll be signed out right away.`)) return;
        await api("/huddle/users/ban", "POST", { username: name, durationSeconds: length, reason: reason.trim() || undefined });
        onNotice(`@${name} is banned.`);
      } else {
        if (!window.confirm(`Permanently delete @${name}'s account? This can't be undone.`)) return;
        const r = await api<{ deletedServers: number }>("/huddle/users/delete", "POST", { username: name, confirm: name, deleteMessages: wipeMessages, deleteOwnedServers: wipeServers });
        onNotice(`@${name}'s account was deleted${r.deletedServers ? ` along with ${r.deletedServers} server${r.deletedServers === 1 ? "" : "s"}` : ""}.`);
      }
      setWho("");
      setReason("");
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function makeResetCode() {
    try {
      setIssued(await api<{ username: string; code: string; minutes: number }>("/huddle/users/reset-code", "POST", { username: helpWho.trim().replace(/^@/, "") }));
    } catch (err) {
      setIssued(null);
      onError(err);
    }
  }
  async function turnOff2fa() {
    const name = helpWho.trim().replace(/^@/, "");
    if (!window.confirm(`Turn off two-factor sign-in for @${name}? Only do this once you're sure it's really them.`)) return;
    try {
      await api("/huddle/users/disable-2fa", "POST", { username: name });
      onNotice(`Two-factor is off for @${name}.`);
    } catch (err) {
      onError(err);
    }
  }

  async function unban(id: string, name: string) {
    try {
      await api(`/huddle/users/${id}/unban`, "POST");
      onNotice(`@${name} is unbanned.`);
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function revoke(id: string, name: string) {
    if (!window.confirm(`Remove Huddle Admin from ${name}?`)) return;
    try {
      await api(`/huddle/admins/${id}`, "DELETE");
      onNotice(`${name} is no longer a Huddle Admin.`);
      load();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <Modal title="Huddle Admin" onClose={onClose}>
      {!data ? (
        <p>Loading…</p>
      ) : (
        <>
          <form className="stack" onSubmit={send}>
            <h3>Send a message as Huddle</h3>
            <label>
              Send to
              <select value={target} onChange={(e) => setTarget(e.target.value as "dms" | "server")}>
                <option value="server">One server</option>
                <option value="dms">Everyone, in their direct messages</option>
              </select>
            </label>
            {target === "server" && (
              <div className="row">
                <label>
                  Server
                  <select value={serverId} onChange={(e) => setServerId(e.target.value)} required>
                    {data.servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.members})</option>)}
                  </select>
                </label>
                <label>
                  Channel
                  <select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                    {server?.channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </select>
                </label>
              </div>
            )}
            <label>
              Message
              <textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} rows={5} required />
            </label>
            {target === "dms" && <small className="hint">Goes to {data.people} {data.people === 1 ? "person" : "people"}, except anyone who has blocked Huddle. People can't reply to it.</small>}
            {data.broadcasting && target === "dms" && <small className="hint">A broadcast is still being delivered. Wait for it to finish before sending another.</small>}
            <button className="primary" disabled={sending || !content.trim() || (target === "server" && !channelId) || (target === "dms" && data.broadcasting)}>
              {sending ? "Sending…" : "Send as Huddle"}
            </button>
          </form>
          <hr />
          <form className="stack danger-zone" onSubmit={moderate}>
            <h3>Ban or delete a person</h3>
            <label>
              Username
              <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Username" maxLength={40} required autoComplete="off" />
            </label>
            <label>
              Action
              <select value={action} onChange={(e) => setAction(e.target.value as "ban" | "delete")}>
                <option value="ban">Ban from Huddle (signs them out)</option>
                <option value="delete">Delete their account completely</option>
              </select>
            </label>
            {action === "ban" ? (
              <div className="row">
                <label>
                  For
                  <select value={banLength} onChange={(e) => setBanLength(e.target.value)}>
                    {BAN_LENGTHS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
                  </select>
                </label>
                <label>
                  Reason (they'll see it when they try to sign in)
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
                </label>
              </div>
            ) : (
              <>
                <label className="check"><input type="checkbox" checked={wipeMessages} onChange={(e) => setWipeMessages(e.target.checked)} /> Also delete all their messages, reactions and poll votes</label>
                <label className="check"><input type="checkbox" checked={wipeServers} onChange={(e) => setWipeServers(e.target.checked)} /> Also delete servers they own (otherwise this is refused if they own any)</label>
                <small className="hint">Their name, picture, bio and memberships are erased and the username frees up. Anything of theirs left in other people's conversations shows as "Deleted user". Other Huddle Admins can't be targeted.</small>
              </>
            )}
            <button className="danger-fill" disabled={!who.trim()}>{action === "ban" ? "Ban" : "Delete account"}</button>
          </form>
          <div className="stack">
            <h3>Help someone get back in</h3>
            <small className="hint">For people who can't use "Forgot password?" (no verified email, or email isn't set up). Check it's really them first, then give them the code by another route. Other Huddle Admins can't be targeted.</small>
            <label>
              Username
              <input value={helpWho} onChange={(e) => { setHelpWho(e.target.value); setIssued(null); }} placeholder="Username" maxLength={40} autoComplete="off" />
            </label>
            <div className="row">
              <button type="button" disabled={!helpWho.trim()} onClick={makeResetCode}>Create a reset code</button>
              <button type="button" disabled={!helpWho.trim()} onClick={turnOff2fa}>Turn off their two-factor</button>
            </div>
            {issued && (
              <div className="stack tight">
                <span>Reset code for @{issued.username} (shown once, works for {issued.minutes} minutes):</span>
                <div className="secret-key">{issued.code}</div>
                <small className="hint">They open Huddle → Forgot your password? → "I already have a code", enter their username, this code, and a new password. If they have two-factor on, they'll also need their authenticator or a recovery code; otherwise turn it off above.</small>
              </div>
            )}
          </div>
          <hr />
          {data.bans.length > 0 && (
            <div className="stack">
              <h3>Banned</h3>
              <ul className="plain-list">
                {data.bans.map((b) => (
                  <li key={b.id}>
                    <span>@{b.username} <small className="hint">{b.permanent ? "Permanent" : `until ${new Date(b.until!).toLocaleString()}`}{b.reason ? ` · ${b.reason}` : ""}</small></span>
                    <button type="button" className="icon" onClick={() => unban(b.id, b.username)}>Unban</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <hr />
          <div className="stack">
            <h3>Huddle Admins</h3>
            <small className="hint">Huddle Admins are admins in every server and can use this panel. Nothing in the app shows who they are.</small>
            <ul className="plain-list">
              {data.admins.map((a) => (
                <li key={a.id}>
                  <span>{a.displayName ?? a.username} <small className="hint">@{a.username}{a.id === meId ? " (you)" : ""}</small></span>
                  {a.locked ? <small className="hint">Permanent</small> : <button type="button" className="icon" onClick={() => revoke(a.id, a.username)}>Remove</button>}
                </li>
              ))}
            </ul>
            <form className="row" onSubmit={grant}>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username to give Huddle Admin" maxLength={40} required aria-label="Username" />
              <button className="primary">Give</button>
            </form>
          </div>
        </>
      )}
    </Modal>
  );
}
