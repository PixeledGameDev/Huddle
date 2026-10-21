import { useEffect, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { Name } from "./Name";
import { STATUS_LABEL, StatusDot } from "./Status";
import type { DmSummary, User } from "./types";
import { nameOfUser } from "./util";

/** Right-hand panel in a DM: who you're talking to, plus block/unblock. */
export default function DmPanel({ dm, onChanged, onError }: { dm: DmSummary; onChanged: () => void; onError: (e: unknown) => void }) {
  const [profile, setProfile] = useState<User | null>(null);
  const name = nameOfUser(dm.user);

  useEffect(() => {
    setProfile(null);
    api<{ profile: User }>(`/users/${dm.user.id}/profile?serverId=${dm.id}`).then((r) => setProfile(r.profile), onError);
  }, [dm.user.id, dm.id, dm.user.avatarVersion, dm.user.displayName]);

  async function toggleBlock() {
    if (!dm.blockedByMe && !window.confirm(`Block ${name}? Neither of you will be able to send messages in this conversation until you unblock them.`)) return;
    try {
      await api(`/users/${dm.user.id}/block`, dm.blockedByMe ? "DELETE" : "PUT");
      onChanged();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <aside className="members dm-panel" aria-label="About this person">
      <Avatar id={dm.user.id} name={name} version={dm.user.avatarVersion} accent={dm.user.accent} size={72} />
      <h3 className="dm-name"><Name user={dm.user} /></h3>
      <p className="muted dm-presence"><StatusDot status={dm.status ?? (dm.online ? "online" : "offline")} className="inline" /> {STATUS_LABEL[dm.status ?? (dm.online ? "online" : "offline")]}</p>
      <p className="muted">@{dm.user.username}</p>
      {dm.user.statusText && <p className="profile-status">{dm.user.statusText}</p>}
      {profile?.bio && <p className="profile-bio">{profile.bio}</p>}
      {profile?.createdAt && <p className="muted small">On Huddle since {new Date(profile.createdAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}</p>}
      {dm.blockedByMe && <p className="timeout-note">You blocked this person. Neither of you can send messages here.</p>}
      <button className={dm.blockedByMe ? "" : "danger"} onClick={() => void toggleBlock()}>{dm.blockedByMe ? "Unblock" : "Block"}</button>
    </aside>
  );
}
