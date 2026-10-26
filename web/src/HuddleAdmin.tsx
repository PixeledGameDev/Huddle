import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "./Dialogs";
import { api } from "./api";
import { Modal } from "./Modals";
import { fmtCountdown, pokeMaintenance, useMaintenance, useRemaining } from "./Maintenance";
import { VerifiedBadge } from "./Verified";

interface Overview {
  admins: { id: string; username: string; displayName: string | null; locked: boolean }[];
  servers: { id: string; name: string; verified: boolean; members: number; channels: { id: string; name: string }[] }[];
  people: number;
  broadcasting: boolean;
  bans: { id: string; username: string; reason: string | null; permanent: boolean; until: string | null }[];
}

const dur = (s?: number | null) => (s ? ` for ${s >= 86400 ? `${Math.round(s / 86400)} day(s)` : `${Math.round(s / 3600)} hour(s)`}` : " permanently");
function adminAuditText(e: { action: string; detail: any; actor: string | null }) {
  const who = `@${e.actor ?? "someone"}`;
  const d = e.detail ?? {};
  switch (e.action) {
    case "send.server": return `${who} sent a message as Huddle to a server`;
    case "broadcast.dms": return `${who} started a broadcast to ${d.recipients} people`;
    case "broadcast.dms.done": return `Broadcast finished: ${d.sent} sent, ${d.skipped} skipped, ${d.failed} failed`;
    case "grant": return `${who} gave Huddle Admin to @${d.username}`;
    case "revoke": return `${who} removed Huddle Admin from @${d.username}`;
    case "ban": return `${who} banned @${d.username}${dur(d.durationSeconds)}${d.reason ? ` (${d.reason})` : ""}`;
    case "unban": return `${who} unbanned @${d.username}`;
    case "delete.account": return `${who} deleted the account @${d.username}${d.deleteMessages ? " and their messages" : ""}${d.deletedServers?.length ? `, plus servers: ${d.deletedServers.join(", ")}` : ""}`;
    case "reset-code": return `${who} created a password reset code for @${d.username}`;
    case "disable-2fa": return `${who} turned off two-factor for @${d.username}`;
    case "maintenance.start": return `${who} turned on maintenance for ${d.minutes} minutes`;
    case "maintenance.change": return `${who} changed the maintenance timer to ${d.minutes} minutes from then`;
    case "maintenance.end": return `${who} ended maintenance`;
    case "server.verify": return `${who} verified ${d.name}`;
    case "server.unverify": return `${who} removed verification from ${d.name}`;
    default: return `${who}: ${e.action}`;
  }
}

const MAINT_LENGTHS: [string, string][] = [["5", "5 minutes"], ["15", "15 minutes"], ["30", "30 minutes"], ["60", "1 hour"], ["120", "2 hours"], ["360", "6 hours"], ["720", "12 hours"], ["1440", "1 day"], ["custom", "Custom…"]];

/** Turns Huddle off for everyone but Huddle Admins, for a set time. */
function MaintenanceSection({ onNotice, onError, onChanged }: { onNotice: (t: string) => void; onError: (e: unknown) => void; onChanged: () => void }) {
  const { state, skew, refresh } = useMaintenance();
  const [length, setLength] = useState("30");
  const [custom, setCustom] = useState("45");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const left = useRemaining(state.active ? state.endsAt : null, skew, refresh);
  const minutes = length === "custom" ? Math.floor(Number(custom)) : Number(length);
  const valid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 10080;
  const label = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    const ok = await confirmDialog(
      state.active
        ? `Change the timer? Maintenance will now end ${label} from now.`
        : `Start maintenance for ${label}? Everyone except Huddle Admins is signed out of the app and locked out until the timer ends.`,
      { confirmLabel: state.active ? "Change timer" : "Start maintenance", danger: !state.active }
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api("/huddle/maintenance", "POST", { minutes, message: message.trim() || undefined });
      onNotice(state.active ? `Maintenance now ends in ${label}.` : `Maintenance is on for ${label}.`);
      await refresh();
      pokeMaintenance();
      onChanged();
    } catch (err) { onError(err); } finally { setBusy(false); }
  }
  async function end() {
    if (!(await confirmDialog("End maintenance now? Everyone can use Huddle again right away.", { confirmLabel: "End maintenance", danger: false }))) return;
    setBusy(true);
    try {
      await api("/huddle/maintenance", "DELETE");
      onNotice("Maintenance ended.");
      await refresh();
      pokeMaintenance();
      onChanged();
    } catch (err) { onError(err); } finally { setBusy(false); }
  }

  return (
    <form className={`stack${state.active ? " maint-on" : ""}`} onSubmit={start}>
      <h3>Maintenance</h3>
      {state.active ? (
        <div className="maint-status">
          <span className="lp-live" aria-hidden="true" />
          <div>
            <b>Maintenance is on</b>
            <small className="hint">{fmtCountdown(left)} left · ends around {new Date(state.endsAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>
          </div>
          <button type="button" className="pill" disabled={busy} onClick={end}>End now</button>
        </div>
      ) : (
        <small className="hint">Turn Huddle off for everyone except Huddle Admins. They see a countdown, and the app and website come back by themselves when it hits zero.</small>
      )}
      <div className="row">
        <label>
          {state.active ? "Reset the timer to" : "How long"}
          <select value={length} onChange={(e) => setLength(e.target.value)}>{MAINT_LENGTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        {length === "custom" && (
          <label>
            Minutes
            <input type="number" min={1} max={10080} value={custom} onChange={(e) => setCustom(e.target.value)} required />
          </label>
        )}
      </div>
      <label>
        Note for people (optional)
        <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="e.g. Upgrading the database" />
      </label>
      <button className={state.active ? "pill" : "danger-fill"} disabled={busy || !valid}>{state.active ? "Change timer" : "Start maintenance"}</button>
    </form>
  );
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

  const [audit, setAudit] = useState<{ id: number; action: string; detail: any; createdAt: string; actor: string | null }[]>([]);
  const [auditMore, setAuditMore] = useState(false);
  const loadAudit = useCallback((more: boolean, last?: number) => {
    api<{ entries: typeof audit; hasMore: boolean }>(`/huddle/audit${more && last ? `?before=${last}` : ""}`).then((r) => {
      setAudit((cur) => (more ? [...cur, ...r.entries] : r.entries));
      setAuditMore(r.hasMore);
    }, onError);
  }, [onError]);
  useEffect(() => loadAudit(false), [loadAudit]);

  async function setVerified(id: string, verified: boolean) {
    try {
      await api(`/huddle/servers/${id}/verified`, "POST", { verified });
      load();
      loadAudit(false);
    } catch (err) { onError(err); }
  }

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
    if (target === "dms" && !await confirmDialog(`Send this to everyone's direct messages (${data.people} people) as Huddle? This can't be undone.`)) return;
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
        if (!await confirmDialog(`Ban @${name} from Huddle ${length ? `for ${BAN_LENGTHS.find(([v]) => v === banLength)![1]}` : "permanently"}? They'll be signed out right away.`)) return;
        await api("/huddle/users/ban", "POST", { username: name, durationSeconds: length, reason: reason.trim() || undefined });
        onNotice(`@${name} is banned.`);
      } else {
        if (!await confirmDialog(`Permanently delete @${name}'s account? This can't be undone.`)) return;
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
    if (!await confirmDialog(`Turn off two-factor sign-in for @${name}? Only do this once you're sure it's really them.`)) return;
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
    if (!await confirmDialog(`Remove Huddle Admin from ${name}?`)) return;
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
          <MaintenanceSection onNotice={onNotice} onError={onError} onChanged={() => loadAudit(false)} />
          <hr />
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
          <div className="stack">
            <h3>Verified servers</h3>
            <small className="hint">Verified servers get a check mark next to their name everywhere. Nothing in a server's own activity log shows who verified it.</small>
            <ul className="plain-list">
              {data.servers.map((s) => (
                <li key={s.id}>
                  <span>{s.name} <small className="hint">{s.members} {s.members === 1 ? "member" : "members"}</small>{s.verified && <VerifiedBadge />}</span>
                  <button type="button" className="icon" onClick={() => void setVerified(s.id, !s.verified)}>{s.verified ? "Remove verification" : "Verify"}</button>
                </li>
              ))}
            </ul>
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
          <hr />
          <div className="stack">
            <h3>Audit log</h3>
            <small className="hint">Everything Huddle Admins have done, newest first.</small>
            <ul className="audit">
              {audit.length === 0 && <li className="hint">Nothing yet.</li>}
              {audit.map((e) => <li key={e.id}><time>{new Date(e.createdAt).toLocaleString()}</time>{adminAuditText(e)}</li>)}
            </ul>
            {auditMore && <button type="button" className="link center-btn" onClick={() => loadAudit(true, audit[audit.length - 1]?.id)}>Load older entries</button>}
          </div>
        </>
      )}
    </Modal>
  );
}
