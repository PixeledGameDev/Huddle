import { DesktopSettings } from "./DesktopSettings";
import { NotificationSettings } from "./NotificationSettings";
import { confirmDialog } from "./Dialogs";
import { SecuritySettings } from "./SecuritySettings";
import { useEffect, useState } from "react";
import { api, ApiError, uploadRaw } from "./api";
import { Avatar } from "./Avatar";
import { NAME_FONTS, type NameFont } from "./fonts";
import { Name } from "./Name";
import { VerifiedBadge } from "./Verified";
import { StatusDot } from "./Status";
import { Modal } from "./Modals";
import { loadPrefs, savePrefs, type Prefs } from "./prefs";
import { can, canModerateMember } from "./permissions";
import type { DmPrivacy, Friendship, Member, Permission, ServerDetail, ServerRole, User } from "./types";
import { actionVerb, bannerImage, hue, nameOfUser, squareImage } from "./util";

interface Mutual { id: string; username: string; displayName: string | null; avatarVersion: number; accent: string | null }
interface ProfileData {
  profile: User;
  server: { role: string; joinedAt: string; roles: { id: string; name: string; color: string | null }[] } | null;
  blockedByMe: boolean;
  friendship?: Friendship;
  canMessage?: boolean;
  mutualServers?: { id: string; name: string; iconVersion: number; verified?: boolean }[];
  mutualFriends?: Mutual[];
}

export function ProfileCard({ userId, serverId, server, meId, onClose, onEdit, onMessage, onChanged, onStartVote, onServerChanged }: { userId: string; serverId: string; server: ServerDetail | null; meId: string; onClose: () => void; onEdit: () => void; onMessage: (userId: string) => void; onChanged: () => void; onStartVote: (m: Member) => void; onServerChanged: () => void }) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState("");
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const [tab, setTab] = useState<"about" | "mutuals" | "roles" | "moderation">("about");
  useEffect(() => {
    api<ProfileData>(`/users/${userId}/profile?serverId=${serverId}`).then(setData, (e) => setError(e.message));
  }, [userId, serverId]);

  async function friendAction(kind: "add" | "accept" | "cancel" | "remove") {
    if (!data) return;
    try {
      if (kind === "add") {
        const r = await api<{ state: Friendship }>("/friends/requests", "POST", { userId });
        setData({ ...data, friendship: r.state });
      } else if (kind === "accept") {
        await api(`/friends/requests/${userId}/accept`, "POST");
        setData({ ...data, friendship: "friends" });
      } else if (kind === "cancel") {
        await api(`/friends/requests/${userId}`, "DELETE");
        setData({ ...data, friendship: "none" });
      } else {
        if (!await confirmDialog(`Remove ${nameOfUser(data.profile)} from your friends?`)) return;
        await api(`/friends/${userId}`, "DELETE");
        setData({ ...data, friendship: "none" });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  async function toggleBlock() {
    if (!data) return;
    const name = nameOfUser(data.profile);
    if (!data.blockedByMe && !await confirmDialog(`Block ${name}? Neither of you will be able to send direct messages until you unblock them.`)) return;
    try {
      await api(`/users/${userId}/block`, data.blockedByMe ? "DELETE" : "PUT");
      setData({ ...data, blockedByMe: !data.blockedByMe });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  async function sendStatusReply() {
    if (!reply.trim()) return;
    try {
      await api(`/users/${userId}/status-reply`, "POST", { content: reply.trim() });
      onMessage(userId); // jump to the conversation
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  // Everything you can do to this person in this server lives in their profile: their roles, and every moderation action.
  const member = server && !server.isDm ? server.members.find((m) => m.id === userId) ?? null : null;
  const roleEditable = (r: ServerRole) => {
    if (!server || !member) return false;
    const self = member.id === meId;
    if (self && r.selfAssignable && r.permissions.length === 0) return true;
    return can(server, "manage_roles") && server.myTop > r.position && (self || server.myTop > member.top);
  };
  const editableRoles = member && server ? server.roles.filter(roleEditable) : [];
  const canMod = !!(server && member && canModerateMember(server, meId, member));
  const staffTarget = !!member && !!server && (member.role !== "member" || member.roleIds.some((id) => server.roles.find((r) => r.id === id)?.permissions.some((x) => x !== "mention_everyone" && x !== "view_audit_log" && x !== "manage_emojis")));
  const canVote = !!(server && member && member.id !== meId && server.settings.voteEnabled && !staffTarget);
  const showRoles = editableRoles.length > 0;
  const showMod = canMod || canVote;
  async function toggleRole(r: ServerRole, has: boolean) {
    if (!server || !member) return;
    try {
      await api(`/servers/${server.id}/members/${member.id}/roles/${r.id}`, has ? "DELETE" : "PUT");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }

  const p = data?.profile;
  const name = p ? nameOfUser(p) : "";
  const other = !!p && p.id !== meId;
  const hasMutuals = other && ((data?.mutualFriends?.length ?? 0) > 0 || (data?.mutualServers?.length ?? 0) > 0);
  const tabs: { id: "about" | "mutuals" | "roles" | "moderation"; label: string; danger?: boolean }[] = [{ id: "about", label: "About" }];
  if (other) tabs.push({ id: "mutuals", label: "Mutuals" });
  if (showRoles) tabs.push({ id: "roles", label: "Roles" });
  if (showMod) tabs.push({ id: "moderation", label: "Moderation", danger: true });
  const current = tabs.some((t) => t.id === tab) ? tab : "about";
  const joined = (iso: string) => new Date(iso).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });

  return (
    <Modal title={p ? name : "Profile"} onClose={onClose} variant="profile">
      {error && <p className="error card-error">{error}</p>}
      {!p && !error && <p className="muted card-loading">Loading…</p>}
      {p && (
        <div className="pcard">
          <div
            className="pcard-banner"
            style={p.bannerVersion ? { backgroundImage: `url(/api/users/${p.id}/banner?v=${p.bannerVersion})` } : { background: `linear-gradient(120deg, ${p.accent ?? `hsl(${hue(p.username)} 70% 62%)`}, color-mix(in srgb, ${p.accent ?? `hsl(${hue(p.username)} 70% 62%)`} 40%, #b58cff))` }}
          />
          <div className="pcard-head">
            <span className="pcard-avatar">
              <Avatar id={p.id} name={name} version={p.avatarVersion} accent={p.accent} size={84} />
              {p.status && <StatusDot status={p.status} />}
            </span>
            <div className="pcard-id">
              <h2>
                <Name user={p} />
                {data?.server && data.server.role !== "member" && <em className="role-chip">{data.server.role}</em>}
                {data?.server?.roles.map((r) => <em key={r.id} className="role-chip" style={{ ["--c" as string]: r.color ?? "var(--dim)" }}>{r.name}</em>)}
              </h2>
              <small className="muted">@{p.username}{data?.server ? ` · Joined ${joined(data.server.joinedAt)}` : ""}</small>
            </div>
          </div>

          {p.statusText && <p className="pcard-status">{p.statusText}</p>}
          {replying && (
            <form className="status-reply" onSubmit={(e) => { e.preventDefault(); void sendStatusReply(); }}>
              <input autoFocus value={reply} maxLength={2000} placeholder="Reply to their status…" onChange={(e) => setReply(e.target.value)} />
              <button className="primary" disabled={!reply.trim()}>Send</button>
            </form>
          )}

          <div className="pcard-actions">
            {p.id === meId ? (
              <button className="pill primary" onClick={onEdit}>Edit profile</button>
            ) : (
              <>
                {!data?.blockedByMe && (
                  <button className="pill primary" disabled={data?.canMessage === false} title={data?.canMessage === false ? "This person isn't accepting new direct messages from you." : undefined} onClick={() => onMessage(p.id)}>Message</button>
                )}
                {!data?.blockedByMe && data?.friendship === "none" && <button className="pill" onClick={() => void friendAction("add")}>Add friend</button>}
                {data?.friendship === "outgoing" && <button className="pill" onClick={() => void friendAction("cancel")}>Cancel request</button>}
                {data?.friendship === "incoming" && <button className="pill" onClick={() => void friendAction("accept")}>Accept request</button>}
                {data?.friendship === "friends" && <button className="pill" onClick={() => void friendAction("remove")}>Friends ✓</button>}
                {p.statusText && !data?.blockedByMe && !replying && <button className="pill" onClick={() => setReplying(true)}>Reply to status</button>}
                <button className="pill danger" onClick={() => void toggleBlock()}>{data?.blockedByMe ? "Unblock" : "Block"}</button>
              </>
            )}
          </div>

          {tabs.length > 1 && (
            <div className="card-tabs" role="tablist">
              {tabs.map((t) => (
                <button key={t.id} role="tab" aria-selected={current === t.id} className={`${current === t.id ? "on" : ""} ${t.danger ? "danger-tab" : ""}`.trim()} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </div>
          )}

          <div className="pcard-panel">
            {current === "about" && (
              <div className="stack">
                {p.bio ? <p className="profile-bio">{p.bio}</p> : <p className="muted">{p.id === meId ? "You haven't written a bio yet." : "No bio yet."}</p>}
                <dl className="profile-meta">
                  {p.status && (<><dt>Status</dt><dd>{p.status === "dnd" ? "Do not disturb" : p.status[0].toUpperCase() + p.status.slice(1)}</dd></>)}
                  {p.createdAt && (<><dt>On Huddle since</dt><dd>{joined(p.createdAt)}</dd></>)}
                  {data?.server && (<><dt>Joined this server</dt><dd>{joined(data.server.joinedAt)}</dd></>)}
                </dl>
              </div>
            )}

            {current === "mutuals" && (
              <div className="stack">
                {!hasMutuals && <p className="muted">No mutual servers or friends yet.</p>}
                {(data?.mutualServers?.length ?? 0) > 0 && (
                  <section>
                    <h4>Mutual servers · {data!.mutualServers!.length}</h4>
                    <ul className="mutual-list">
                      {data!.mutualServers!.map((s) => (
                        <li key={s.id} title={s.name}>
                          {s.iconVersion > 0 ? <img className="mutual-icon" src={`/api/servers/${s.id}/icon?v=${s.iconVersion}`} alt="" /> : <span className="mutual-icon" style={{ background: `hsl(${hue(s.name)} 38% 40%)` }}>{s.name[0].toUpperCase()}</span>}
                          <span>{s.name}</span>{s.verified && <VerifiedBadge />}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
                {(data?.mutualFriends?.length ?? 0) > 0 && (
                  <section>
                    <h4>Mutual friends · {data!.mutualFriends!.length}</h4>
                    <ul className="mutual-list">
                      {data!.mutualFriends!.map((f) => (
                        <li key={f.id} title={`@${f.username}`}><Avatar id={f.id} name={nameOfUser(f)} version={f.avatarVersion} accent={f.accent} size={22} /><span>{nameOfUser(f)}</span></li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            )}

            {current === "roles" && member && server && (
              <div className="stack">
                <p className="muted">{member.id === meId ? "Give yourself or take off any role you're allowed to." : `Roles for ${name}. You can only change roles ranked below your own.`}</p>
                <div className="chips">
                  {editableRoles.map((r) => {
                    const has = member.roleIds.includes(r.id);
                    return (
                      <label key={r.id} className={has ? "role-pick on" : "role-pick"} style={{ ["--c" as string]: r.color ?? "var(--accent)" }}>
                        <input type="checkbox" checked={has} onChange={() => void toggleRole(r, has)} />{r.name}
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {current === "moderation" && member && server && (
              <div className="stack">
                {canMod && <ModerationForm server={server} target={member} onError={(e) => setError(e instanceof Error ? e.message : "Something went wrong.")} onDone={(kind) => { onServerChanged(); if (kind === "kick" || kind === "ban") onClose(); }} />}
                {canVote && (
                  <div className="vote-row">
                    <button type="button" onClick={() => { onStartVote(member); onClose(); }}>Start a vote to {actionVerb(server.settings.voteAction)}</button>
                    <small className="muted">Lets everyone decide instead of acting on your own.</small>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function MyProfileModal({ me, onClose, onUser, onDeleted, onError, onOpenThemes }: { me: User; onClose: () => void; onUser: (u: User) => void; onDeleted: () => void; onError: (e: unknown) => void; onOpenThemes: () => void }) {
  const [displayName, setDisplayName] = useState(me.displayName ?? "");
  const [statusText, setStatusText] = useState(me.statusText);
  const [bio, setBio] = useState(me.bio);
  const [accent, setAccent] = useState<string | null>(me.accent);
  const [nameFont, setNameFont] = useState<NameFont>((me.nameFont as NameFont) ?? "default");
  const [dmPrivacy, setDmPrivacy] = useState<DmPrivacy>(me.dmPrivacy ?? "everyone");
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs());
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delPassword, setDelPassword] = useState("");
  const [delMessages, setDelMessages] = useState(false);
  const [delCode, setDelCode] = useState("");
  const [delNeedsCode, setDelNeedsCode] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>("/me/profile", "PATCH", { displayName: displayName.trim() || null, statusText: statusText.trim(), bio: bio.trim(), accent, dmPrivacy, nameFont });
      onUser(user);
      onClose();
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  }

  async function pickAvatar(file: File) {
    try {
      const { user } = await uploadRaw<{ user: User }>("/me/avatar", await squareImage(file, 256));
      onUser(user);
    } catch (err) {
      onError(err);
    }
  }

  async function pickBanner(file: File) {
    try {
      const { user } = await uploadRaw<{ user: User }>("/me/banner", await bannerImage(file));
      onUser(user);
    } catch (err) {
      onError(err);
    }
  }

  const updatePrefs = (p: Prefs) => { setPrefs(p); savePrefs(p); };

  return (
    <Modal title="Profile & appearance" onClose={onClose}>
      <div className="avatar-edit">
        <Avatar id={me.id} name={nameOfUser(me)} version={me.avatarVersion} accent={me.accent} size={72} />
        <div className="stack tight">
          <label className="file-btn">
            Upload picture
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickAvatar(f); e.target.value = ""; }} />
          </label>
          {me.avatarVersion > 0 && (
            <button type="button" className="link left" onClick={async () => { try { onUser((await api<{ user: User }>("/me/avatar", "DELETE")).user); } catch (err) { onError(err); } }}>Remove picture</button>
          )}
        </div>
      </div>
      <div className="banner-edit">
        <div className="profile-banner" style={me.bannerVersion ? { backgroundImage: `url(/api/users/${me.id}/banner?v=${me.bannerVersion})`, backgroundSize: "cover", backgroundPosition: "center" } : { background: accent ?? `hsl(${hue(me.username)} 45% 42%)` }} />
        <div className="row-actions">
          <label className="file-btn">Upload banner<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickBanner(f); e.target.value = ""; }} /></label>
          {!!me.bannerVersion && <button type="button" className="link" onClick={async () => { try { onUser((await api<{ user: User }>("/me/banner", "DELETE")).user); } catch (err) { onError(err); } }}>Remove banner</button>}
        </div>
      </div>
      <form className="stack" onSubmit={save}>
        <label>Display name<input value={displayName} maxLength={32} placeholder={me.username} onChange={(e) => setDisplayName(e.target.value)} /><small className="muted">Shown instead of @{me.username}. People still @mention you as @{me.username}.</small></label>
        <label>Display name font
          <select value={nameFont} onChange={(e) => setNameFont(e.target.value as NameFont)}>{NAME_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
          <span className="font-preview"><Name user={{ username: me.username, displayName: displayName.trim() || null, nameFont }} /></span>
        </label>
        <label>Status<input value={statusText} maxLength={80} placeholder="What are you up to?" onChange={(e) => setStatusText(e.target.value)} /></label>
        <label>About me<textarea value={bio} maxLength={190} rows={3} onChange={(e) => setBio(e.target.value)} /><small className="muted">{bio.length}/190</small></label>
        <div className="color-row">
          <label>Profile color<input type="color" value={accent ?? "#3556d8"} onChange={(e) => setAccent(e.target.value)} /></label>
          {accent && <button type="button" className="link" onClick={() => setAccent(null)}>Use automatic color</button>}
        </div>
        <label>Who can start a direct message with you
          <select value={dmPrivacy} onChange={(e) => setDmPrivacy(e.target.value as DmPrivacy)}>
            <option value="everyone">Anyone who shares a server with me</option>
            <option value="friends">Only my friends</option>
            <option value="nobody">Nobody</option>
          </select>
          <small className="muted">This only affects new conversations. Existing ones keep working, and you can still block people.</small>
        </label>
        <button className="primary" disabled={busy}>Save profile</button>
      </form>
      <hr />
      <h3>Appearance</h3>
      <div className="grid">
        <label>Theme
          <select value={prefs.theme} onChange={(e) => updatePrefs({ ...prefs, theme: e.target.value as Prefs["theme"] })}>
            <option value="system">Match my device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label>Message spacing
          <select value={prefs.density} onChange={(e) => updatePrefs({ ...prefs, density: e.target.value as Prefs["density"] })}>
            <option value="cozy">Cozy</option>
            <option value="compact">Compact</option>
          </select>
        </label>
      </div>
      {window.huddleDesktop && (
        <div className="stack tight">
          <button type="button" onClick={onOpenThemes}>Custom themes…</button>
          <small className="muted">Design your own colors and background pictures (desktop app only). While a custom theme is on, the Theme setting above is paused.</small>
        </div>
      )}
      <hr />
      <NotificationSettings />
      <DesktopSettings />
      <hr />
      <SecuritySettings onError={onError} />
      <hr />
      <div className="stack danger-zone">
        <h3>Delete account</h3>
        {!deleting ? (
          <>
            <p className="muted">Permanently deletes your account. Your name, picture, bio and memberships are removed and your username becomes available again. You can't undo this.</p>
            <button type="button" className="danger" onClick={() => setDeleting(true)}>Delete my account…</button>
          </>
        ) : (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!await confirmDialog("Delete your account for good? This can't be undone.")) return;
              try {
                await api("/me", "DELETE", { password: delPassword, deleteMessages: delMessages, code: delNeedsCode ? delCode : undefined });
                onDeleted();
              } catch (err) {
                if (err instanceof ApiError && err.data?.needs2fa) setDelNeedsCode(true);
                onError(err);
              }
            }}
          >
            <p className="muted">Your old messages stay in the conversations they were part of, shown as from "Deleted user", unless you also delete them. If you own servers, delete them first.</p>
            <label className="check"><input type="checkbox" checked={delMessages} onChange={(e) => setDelMessages(e.target.checked)} /> Also delete all my messages, reactions and poll votes</label>
            <label>Your password<input type="password" value={delPassword} onChange={(e) => setDelPassword(e.target.value)} autoComplete="current-password" required /></label>
            {delNeedsCode && <label>Authenticator or recovery code<input value={delCode} onChange={(e) => setDelCode(e.target.value)} autoComplete="one-time-code" required /></label>}
            <div className="row">
              <button type="button" onClick={() => { setDeleting(false); setDelPassword(""); }}>Cancel</button>
              <button className="danger-fill" disabled={!delPassword}>Delete my account</button>
            </div>
          </form>
        )}
      </div>
      <p className="muted credits">Emoji graphics are Twemoji by Twitter and contributors, used under CC-BY 4.0.</p>
    </Modal>
  );
}

const TIMEOUT_LENGTHS: [string, string][] = [["60", "1 minute"], ["300", "5 minutes"], ["600", "10 minutes"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"]];
const BAN_LENGTHS: [string, string][] = [["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"], ["2592000", "30 days"], ["", "Permanent"]];

/** Time out, kick or ban: every moderation action for a person, shown inside their profile. */
export function ModerationForm({ server, target, onDone, onError }: { server: ServerDetail; target: Member; onDone: (kind: "timeout" | "untimeout" | "kick" | "ban") => void; onError: (e: unknown) => void }) {
  const [action, setAction] = useState<"timeout" | "kick" | "ban">("timeout");
  const [duration, setDuration] = useState("600");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const name = nameOfUser(target);
  const isTimedOut = !!target.timeoutUntil && new Date(target.timeoutUntil) > new Date();
  const has = (p: Permission) => server.myPermissions.includes(p);
  const allowed = (["timeout", "kick", "ban"] as const).filter((a) => has(a === "timeout" ? "timeout_members" : a === "kick" ? "kick_members" : "ban_members"));

  async function run(act: "timeout" | "untimeout" | "kick" | "ban", durationSeconds?: number | null) {
    setBusy(true);
    try {
      await api(`/servers/${server.id}/moderation`, "POST", { targetId: target.id, action: act, durationSeconds, reason: reason.trim() || undefined });
      onDone(act);
    } catch (err) {
      onError(err);
    }
    setBusy(false);
  }

  const pick = allowed.includes(action) ? action : allowed[0];
  const changeAction = (a: typeof action) => { setAction(a); setDuration(a === "timeout" ? "600" : a === "ban" ? "86400" : ""); };
  const lengths = pick === "timeout" ? TIMEOUT_LENGTHS : BAN_LENGTHS;
  if (!pick) return <p className="muted">You don't have a moderation permission.</p>;

  return (
    <div className="stack">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(pick, pick === "kick" ? undefined : duration ? Number(duration) : null); }}>
        <div className="seg" role="group" aria-label="Action (applies immediately, no vote)">
          {allowed.map((a) => <button type="button" key={a} className={pick === a ? "on" : ""} onClick={() => changeAction(a)}>{a === "timeout" ? "Time out" : a === "kick" ? "Kick" : "Ban"}</button>)}
        </div>
        {pick !== "kick" && (
          <label>{pick === "timeout" ? "Timeout length" : "Ban length"}
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>{lengths.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        <label>Reason (saved to the activity log)<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Optional" /></label>
        {pick === "kick" && <p className="muted">They can rejoin with an invite code.</p>}
        <button className="primary danger-fill" disabled={busy}>{pick === "timeout" ? "Time out" : pick === "kick" ? "Kick" : "Ban"} {name}</button>
      </form>
      {isTimedOut && has("timeout_members") && <button disabled={busy} onClick={() => void run("untimeout")}>Remove {name}'s timeout</button>}
    </div>
  );
}
