import { useEffect, useState } from "react";
import { api, uploadRaw } from "./api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modals";
import { loadPrefs, savePrefs, type Prefs } from "./prefs";
import type { Member, ServerDetail, User } from "./types";
import { hue, nameOfUser, squareImage } from "./util";

export function ProfileCard({ userId, serverId, meId, onClose, onEdit }: { userId: string; serverId: string; meId: string; onClose: () => void; onEdit: () => void }) {
  const [data, setData] = useState<{ profile: User; server: { role: string; joinedAt: string } | null } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ profile: User; server: { role: string; joinedAt: string } | null }>(`/users/${userId}/profile?serverId=${serverId}`).then(setData, (e) => setError(e.message));
  }, [userId, serverId]);

  const p = data?.profile;
  const name = p ? nameOfUser(p) : "";
  return (
    <Modal title={p ? name : "Profile"} onClose={onClose}>
      {error && <p className="error">{error}</p>}
      {p && (
        <div className="profile-card">
          <div className="profile-banner" style={{ background: p.accent ?? `hsl(${hue(p.username)} 45% 42%)` }} />
          <div className="profile-avatar"><Avatar id={p.id} name={name} version={p.avatarVersion} accent={p.accent} size={84} /></div>
          <h3>{name}</h3>
          <p className="muted">@{p.username}{data?.server && data.server.role !== "member" && <em className="tag">{data.server.role}</em>}</p>
          {p.statusText && <p className="profile-status">{p.statusText}</p>}
          {p.bio && <p className="profile-bio">{p.bio}</p>}
          <dl className="profile-meta">
            {p.createdAt && (<><dt>On Huddle since</dt><dd>{new Date(p.createdAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}</dd></>)}
            {data?.server && (<><dt>Joined this server</dt><dd>{new Date(data.server.joinedAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}</dd></>)}
          </dl>
          {p.id === meId && <button className="primary" onClick={onEdit}>Edit profile</button>}
        </div>
      )}
    </Modal>
  );
}

export function MyProfileModal({ me, onClose, onUser, onError }: { me: User; onClose: () => void; onUser: (u: User) => void; onError: (e: unknown) => void }) {
  const [displayName, setDisplayName] = useState(me.displayName ?? "");
  const [statusText, setStatusText] = useState(me.statusText);
  const [bio, setBio] = useState(me.bio);
  const [accent, setAccent] = useState<string | null>(me.accent);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs());
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>("/me/profile", "PATCH", { displayName: displayName.trim() || null, statusText: statusText.trim(), bio: bio.trim(), accent });
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
      <form className="stack" onSubmit={save}>
        <label>Display name<input value={displayName} maxLength={32} placeholder={me.username} onChange={(e) => setDisplayName(e.target.value)} /><small className="muted">Shown instead of @{me.username}. People still @mention you as @{me.username}.</small></label>
        <label>Status<input value={statusText} maxLength={80} placeholder="What are you up to?" onChange={(e) => setStatusText(e.target.value)} /></label>
        <label>About me<textarea value={bio} maxLength={190} rows={3} onChange={(e) => setBio(e.target.value)} /><small className="muted">{bio.length}/190</small></label>
        <div className="color-row">
          <label>Profile color<input type="color" value={accent ?? "#3556d8"} onChange={(e) => setAccent(e.target.value)} /></label>
          {accent && <button type="button" className="link" onClick={() => setAccent(null)}>Use automatic color</button>}
        </div>
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
      <p className="muted credits">Emoji graphics are Twemoji by Twitter and contributors, used under CC-BY 4.0.</p>
    </Modal>
  );
}

const TIMEOUT_LENGTHS: [string, string][] = [["60", "1 minute"], ["300", "5 minutes"], ["600", "10 minutes"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"]];
const BAN_LENGTHS: [string, string][] = [["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"], ["2592000", "30 days"], ["", "Permanent"]];

export function ModerateModal({ server, target, onClose, onDone, onError }: { server: ServerDetail; target: Member; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const [action, setAction] = useState<"timeout" | "kick" | "ban">("timeout");
  const [duration, setDuration] = useState("600");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const name = nameOfUser(target);
  const isTimedOut = !!target.timeoutUntil && new Date(target.timeoutUntil) > new Date();

  async function run(act: string, durationSeconds?: number | null) {
    setBusy(true);
    try {
      await api(`/servers/${server.id}/moderation`, "POST", { targetId: target.id, action: act, durationSeconds, reason: reason.trim() || undefined });
      onDone();
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  }

  const changeAction = (a: typeof action) => { setAction(a); setDuration(a === "timeout" ? "600" : a === "ban" ? "86400" : ""); };
  const lengths = action === "timeout" ? TIMEOUT_LENGTHS : BAN_LENGTHS;

  return (
    <Modal title={`Moderate ${name}`} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(action, action === "kick" ? undefined : duration ? Number(duration) : null); }}>
        <fieldset className="radio-row">
          <legend className="label-text">Action (applies immediately, no vote)</legend>
          {(["timeout", "kick", "ban"] as const).map((a) => (
            <label key={a} className="check"><input type="radio" name="action" checked={action === a} onChange={() => changeAction(a)} />{a === "timeout" ? "Time out" : a === "kick" ? "Kick" : "Ban"}</label>
          ))}
        </fieldset>
        {action !== "kick" && (
          <label>{action === "timeout" ? "Timeout length" : "Ban length"}
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>{lengths.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </label>
        )}
        <label>Reason (saved to the activity log)<input value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></label>
        {action === "kick" && <p className="muted">They can rejoin with an invite code.</p>}
        <button className="primary danger-fill" disabled={busy}>{action === "timeout" ? "Time out" : action === "kick" ? "Kick" : "Ban"} {name}</button>
      </form>
      {isTimedOut && (
        <>
          <hr />
          <button disabled={busy} onClick={() => void run("untimeout")}>Remove {name}'s timeout</button>
        </>
      )}
    </Modal>
  );
}
