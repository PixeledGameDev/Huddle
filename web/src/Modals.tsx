import { useEffect, useState } from "react";
import { api, uploadRaw } from "./api";
import { can, isOwner } from "./permissions";
import { EmojiTab } from "./EmojiSettings";
import { RolesTab } from "./Roles";
import type { BanEntry, DeletedMessage, ServerDetail, ServerSummary, Settings } from "./types";
import { dateTimeOf, extractInviteCode, fmtDuration, fmtSize, hue, squareImage } from "./util";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
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
          try { onDone((await api<{ server: ServerSummary }>("/join", "POST", { code: extractInviteCode(code) })).server); } catch (err) { onError(err); }
        }}
      >
        <label>Join with an invite link or code<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the link or code" required /></label>
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

const durationText = (d: any) => (d?.durationSeconds ? ` for ${fmtDuration(d.durationSeconds)}` : "");
const reasonText = (d: any) => (d?.reason ? ` (${d.reason})` : "");
const AUDIT_TEXT: Record<string, (e: any) => string> = {
  "vote.start": (e) => `${e.actor} started a vote on ${e.target}`,
  "vote.passed": (e) => `Vote on ${e.target} passed (${e.detail?.action})`,
  "vote.failed": (e) => `Vote on ${e.target} failed`,
  "settings.update": (e) => `${e.actor} changed server settings`,
  "server.rename": (e) => `${e.actor} renamed the server from ${e.detail?.from} to ${e.detail?.to}`,
  "role.create": (e) => `${e.actor} created the role ${e.detail?.name}`,
  "role.update": (e) => `${e.actor} edited the role ${e.detail?.name}`,
  "role.delete": (e) => `${e.actor} deleted the role ${e.detail?.name}`,
  "role.reorder": (e) => `${e.actor} moved the role ${e.detail?.name} ${e.detail?.direction}`,
  "role.assign": (e) => `${e.actor} gave ${e.target} the role ${e.detail?.name}`,
  "role.unassign": (e) => `${e.actor} took the role ${e.detail?.name} from ${e.target}`,
  "role.legacy": (e) => (e.detail?.mode === "role" ? `${e.actor} turned ${e.detail?.count} admin(s) into the role ${e.detail?.name}` : `${e.actor} removed the admin rank from ${e.detail?.count} member(s)`),
  "mod.kick": (e) => `${e.actor} kicked ${e.target}${reasonText(e.detail)}`,
  "mod.ban": (e) => `${e.actor} banned ${e.target}${e.detail?.durationSeconds ? durationText(e.detail) : " permanently"}${reasonText(e.detail)}`,
  "mod.unban": (e) => `${e.actor} unbanned ${e.target}`,
  "mod.timeout": (e) => `${e.actor} timed out ${e.target}${durationText(e.detail)}${reasonText(e.detail)}`,
  "mod.untimeout": (e) => `${e.actor} removed ${e.target}'s timeout`,
  "channel.create": (e) => `${e.actor} created #${e.detail?.name}`,
  "channel.rename": (e) => `${e.actor} renamed #${e.detail?.from} to #${e.detail?.to}`,
  "channel.delete": (e) => `${e.actor} deleted #${e.detail?.name}`,
  "server.icon": (e) => (e.detail?.removed ? `${e.actor} removed the server icon` : `${e.actor} changed the server icon`),
  "emoji.add": (e) => `${e.actor} added the emoji :${e.detail?.name}:`,
  "emoji.rename": (e) => `${e.actor} renamed the emoji :${e.detail?.from}: to :${e.detail?.to}:`,
  "emoji.delete": (e) => `${e.actor} deleted the emoji :${e.detail?.name}:`,
  "sticker.add": (e) => `${e.actor} added the sticker ${e.detail?.name}`,
  "sticker.rename": (e) => `${e.actor} renamed the sticker ${e.detail?.from} to ${e.detail?.to}`,
  "sticker.delete": (e) => `${e.actor} deleted the sticker ${e.detail?.name}`,
  "member.join": (e) => `${e.actor} joined the server`,
  "member.leave": (e) => `${e.actor} left the server`,
  "message.delete": (e) => `${e.actor} deleted a message by ${e.target}`,
};

type Tab = "general" | "roles" | "emojis" | "bans" | "deleted" | "activity" | "danger";

export function SettingsModal({ server, onClose, onSaved, onDeleted, onError }: { server: ServerDetail; onClose: () => void; onSaved: () => void; onDeleted: () => void; onError: (e: unknown) => void }) {
  const tabs: [Tab, string][] = [];
  if (can(server, "manage_server")) tabs.push(["general", "General"]);
  if (can(server, "manage_roles") || server.roles.length > 0) tabs.push(["roles", "Roles"]);
  if (can(server, "manage_emojis")) tabs.push(["emojis", "Emoji & stickers"]);
  if (can(server, "ban_members")) tabs.push(["bans", "Bans"]);
  if (can(server, "manage_messages")) tabs.push(["deleted", "Deleted messages"]);
  if (can(server, "view_audit_log")) tabs.push(["activity", "Activity"]);
  if (isOwner(server)) tabs.push(["danger", "Danger zone"]);
  const [tab, setTab] = useState<Tab>(tabs[0]?.[0] ?? "general");
  const [s, setS] = useState<Settings>(server.settings);
  const [audit, setAudit] = useState<any[]>([]);
  const [auditMore, setAuditMore] = useState(false);
  const [auditCategory, setAuditCategory] = useState("");
  const [bans, setBans] = useState<BanEntry[]>([]);
  const [deleted, setDeleted] = useState<DeletedMessage[]>([]);
  const [confirmName, setConfirmName] = useState("");
  const [newName, setNewName] = useState(server.name);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));

  const loadAudit = (more: boolean, category = auditCategory) => {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (more && audit.length) params.set("before", String(audit[audit.length - 1].id));
    return api<{ entries: any[]; hasMore: boolean }>(`/servers/${server.id}/audit?${params}`).then((r) => {
      setAudit((cur) => (more ? [...cur, ...r.entries] : r.entries));
      setAuditMore(r.hasMore);
    }, onError);
  };
  const loadBans = () => api<{ bans: BanEntry[] }>(`/servers/${server.id}/bans`).then((r) => setBans(r.bans), onError);
  useEffect(() => {
    if (tab === "activity") void loadAudit(false);
    if (tab === "bans") void loadBans();
    if (tab === "deleted") api<{ messages: DeletedMessage[] }>(`/servers/${server.id}/deleted`).then((r) => setDeleted(r.messages), onError);
  }, [tab, server.id]);

  async function setIcon(file: File) {
    try {
      await uploadRaw(`/servers/${server.id}/icon`, await squareImage(file, 128));
    } catch (err) { onError(err); }
  }

  return (
    <Modal title={`${server.name} settings`} onClose={onClose}>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "tab on" : "tab"} onClick={() => setTab(id)}>{label}</button>)}
      </div>

      {tab === "general" && (
        <>
          <div className="avatar-edit">
            {server.iconVersion > 0
              ? <img className="srv-preview" src={`/api/servers/${server.id}/icon?v=${server.iconVersion}`} alt="" />
              : <span className="srv-preview" style={{ background: `hsl(${hue(server.name)} 38% 40%)` }}>{server.name[0].toUpperCase()}</span>}
            <div className="stack tight">
              <label className="file-btn">Upload server icon<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void setIcon(f); e.target.value = ""; }} /></label>
              {server.iconVersion > 0 && <button type="button" className="link left" onClick={() => api(`/servers/${server.id}/icon`, "DELETE").catch(onError)}>Remove icon</button>}
            </div>
          </div>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/servers/${server.id}/name`, "PATCH", { name: newName });
                onSaved();
              } catch (err) { onError(err); }
            }}
          >
            <label>Server name<input value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} required /></label>
            <button className="primary" disabled={!newName.trim() || newName.trim() === server.name}>Rename server</button>
          </form>
          <hr />
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
              <Select label="Who can vote" value={s.voteMinMemberAgeSeconds} options={MIN_AGE} onChange={(n) => set("voteMinMemberAgeSeconds", n)} hint="Minimum time in the server. The owner always can." />
            </fieldset>
            <p className="muted">The owner and anyone with a moderation permission can't be voted on. People with those permissions can still moderate anyone ranked below them instantly from the member list.</p>
            <button className="primary">Save changes</button>
          </form>
        </>
      )}

      {tab === "roles" && <RolesTab server={server} onError={onError} />}

      {tab === "emojis" && <EmojiTab server={server} onError={onError} />}

      {tab === "bans" && (
        <ul className="rows">
          {bans.length === 0 && <li className="muted">Nobody is banned.</li>}
          {bans.map((b) => (
            <li key={b.userId}>
              <span><strong>{b.name}</strong> <small className="muted">@{b.username} · {b.permanent ? "Permanent" : `until ${dateTimeOf(b.until!)}`}</small></span>
              <button onClick={async () => { try { await api(`/servers/${server.id}/moderation`, "POST", { targetId: b.userId, action: "unban" }); await loadBans(); } catch (err) { onError(err); } }}>Unban</button>
            </li>
          ))}
        </ul>
      )}

      {tab === "deleted" && (
        <>
          <p className="muted">Deleted messages disappear for everyone else. Only people who can manage messages can see them here. File contents are removed; only their names are kept.</p>
          <ul className="rows deleted">
            {deleted.length === 0 && <li className="muted">No deleted messages.</li>}
            {deleted.map((d) => (
              <li key={d.id}>
                <div className="del-meta"><strong>{d.authorName}</strong> in #{d.channelName} <span className="muted">· sent {dateTimeOf(d.createdAt)} · deleted {dateTimeOf(d.deletedAt)} by {d.deletedById === d.authorId ? "the author" : d.deletedByName}</span></div>
                {d.content && <p className="del-text">{d.content}</p>}
                {d.gif && <small className="muted">GIF: {d.gif}</small>}
                {d.attachments.map((a, i) => <small key={i} className="muted">File: {a.name} ({fmtSize(a.size)})</small>)}
                {d.poll && <small className="muted">Poll: {d.poll.question} ({d.poll.options.join(", ")})</small>}
              </li>
            ))}
          </ul>
        </>
      )}

      {tab === "danger" && isOwner(server) && (
        <form
          className="stack danger-zone"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api(`/servers/${server.id}`, "DELETE", { name: confirmName });
              onDeleted();
            } catch (err) { onError(err); }
          }}
        >
          <h3>Delete this server</h3>
          <p className="muted">This permanently deletes <strong>{server.name}</strong> for everyone: every channel, message, file, invite and ban. It can't be undone.</p>
          <label>Type the server's name to confirm<input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={server.name} autoComplete="off" /></label>
          <button className="danger-fill" disabled={confirmName.trim() !== server.name}>Delete server forever</button>
        </form>
      )}

      {tab === "activity" && (
        <>
        <label className="audit-filter">Show
          <select value={auditCategory} onChange={(e) => { setAuditCategory(e.target.value); void loadAudit(false, e.target.value); }}>
            <option value="">Everything</option>
            <option value="moderation">Moderation and votes</option>
            <option value="roles">Roles</option>
            <option value="channels">Channels</option>
            <option value="members">Joins and leaves</option>
            <option value="messages">Deleted messages</option>
            <option value="settings">Settings and icon</option>
          </select>
        </label>
        <ul className="audit">
          {audit.length === 0 && <li className="muted">Nothing yet.</li>}
          {audit.map((e) => (
            <li key={e.id}>
              <time>{dateTimeOf(e.createdAt)}</time>
              {(AUDIT_TEXT[e.action] ?? (() => e.action))(e)}
            </li>
          ))}
        </ul>
        {auditMore && <button className="link center-btn" onClick={() => void loadAudit(true)}>Load older entries</button>}
        </>
      )}
    </Modal>
  );
}
