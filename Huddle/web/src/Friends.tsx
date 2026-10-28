import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "./Dialogs";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modals";
import { Name } from "./Name";
import { StatusDot, STATUS_LABEL } from "./Status";
import type { FriendUser } from "./types";
import { nameOfUser } from "./util";

interface FriendsData { friends: FriendUser[]; incoming: FriendUser[]; outgoing: FriendUser[] }

/** Loads the friends lists and keeps them fresh whenever the server says something changed. */
export function useFriends(refreshKey: number) {
  const [data, setData] = useState<FriendsData>({ friends: [], incoming: [], outgoing: [] });
  const reload = useCallback(() => { api<FriendsData>("/friends").then(setData, () => {}); }, []);
  useEffect(reload, [reload, refreshKey]);
  return { data, reload };
}

export function FriendsModal({ data, refreshKey, onClose, onOpenProfile, onMessage, onError, onNotice }: {
  data: FriendsData;
  refreshKey: number;
  onClose: () => void;
  onOpenProfile: (userId: string) => void;
  onMessage: (userId: string) => void;
  onError: (e: unknown) => void;
  onNotice: (text: string) => void;
}) {
  const [tab, setTab] = useState<"all" | "pending">(data.incoming.length ? "pending" : "all");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  void refreshKey;
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { onError(e); } };

  const row = (u: FriendUser, actions: React.ReactNode) => (
    <li key={u.id}>
      <button className="member-id" onClick={() => onOpenProfile(u.id)}>
        <span className="avatar-wrap"><Avatar id={u.id} name={nameOfUser(u)} version={u.avatarVersion} accent={u.accent} size={32} /><StatusDot status={u.status} /></span>
        <span className="member-name"><span className="member-line"><Name user={u} /></span><small className="member-status">@{u.username}{u.status !== "offline" ? ` · ${STATUS_LABEL[u.status]}` : ""}</small></span>
      </button>
      <span className="member-actions always">{actions}</span>
    </li>
  );

  return (
    <Modal title="Friends" onClose={onClose}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "all"} className={tab === "all" ? "tab on" : "tab"} onClick={() => setTab("all")}>Friends · {data.friends.length}</button>
        <button role="tab" aria-selected={tab === "pending"} className={tab === "pending" ? "tab on" : "tab"} onClick={() => setTab("pending")}>
          Pending{data.incoming.length > 0 && <span className="badge inline">{data.incoming.length}</span>}
        </button>
      </div>
      <form
        className="friend-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!username.trim()) return;
          setBusy(true);
          await run(async () => {
            const r = await api<{ state: string }>("/friends/requests", "POST", { username: username.trim().replace(/^@/, "") });
            onNotice(r.state === "friends" ? "You're now friends." : "Friend request sent.");
            setUsername("");
          });
          setBusy(false);
        }}
      >
        <input value={username} maxLength={40} placeholder="Add a friend by username" aria-label="Username" onChange={(e) => setUsername(e.target.value)} />
        <button className="primary" disabled={busy || !username.trim()}>Send request</button>
      </form>
      {tab === "all" && (
        <ul className="rows people">
          {data.friends.length === 0 && <li className="muted">No friends yet. Open someone's profile and choose Add friend.</li>}
          {data.friends.map((u) => row(u, (
            <>
              <button onClick={() => { onMessage(u.id); onClose(); }}>Message</button>
              <button className="danger" onClick={async () => { if (await confirmDialog(`Remove ${nameOfUser(u)} from your friends?`)) void run(() => api(`/friends/${u.id}`, "DELETE")); }}>Remove</button>
            </>
          )))}
        </ul>
      )}
      {tab === "pending" && (
        <ul className="rows people">
          {data.incoming.length === 0 && data.outgoing.length === 0 && <li className="muted">No pending requests.</li>}
          {data.incoming.map((u) => row(u, (
            <>
              <button className="primary" onClick={() => void run(() => api(`/friends/requests/${u.id}/accept`, "POST"))}>Accept</button>
              <button onClick={() => void run(() => api(`/friends/requests/${u.id}`, "DELETE"))}>Decline</button>
            </>
          )))}
          {data.outgoing.map((u) => row(u, (
            <>
              <small className="muted">Request sent</small>
              <button onClick={() => void run(() => api(`/friends/requests/${u.id}`, "DELETE"))}>Cancel</button>
            </>
          )))}
        </ul>
      )}
    </Modal>
  );
}
