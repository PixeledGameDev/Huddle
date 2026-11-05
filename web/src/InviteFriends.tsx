import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modals";
import { Name } from "./Name";
import { StatusDot } from "./Status";
import type { FriendUser, ServerDetail } from "./types";
import { nameOfUser } from "./util";

type Sent = { state: "sending" } | { state: "sent" } | { state: "failed"; reason: string };
type SendResults = { results: Record<string, { sent: boolean; reason?: string }> };

/** What "Invite" opens: send the server's invite link straight to a friend as a direct message, or copy the link. */
export function InviteFriendsModal({ server, friends, onClose, onError, onNotice }: {
  server: ServerDetail;
  friends: FriendUser[];
  onClose: () => void;
  onError: (e: unknown) => void;
  onNotice: (text: string) => void;
}) {
  const [link, setLink] = useState("");
  const [query, setQuery] = useState("");
  const [sent, setSent] = useState<Record<string, Sent>>({});

  // One fresh invite link per time the window is opened.
  useEffect(() => {
    let live = true;
    api<{ code: string }>(`/servers/${server.id}/invites`, "POST").then(
      ({ code }) => { if (live) setLink(`${window.location.origin}/invite/${code}`); },
      (e) => { if (live) { onError(e); onClose(); } }
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const memberIds = useMemo(() => new Set(server.members.map((m) => m.id)), [server.members]);
  const shown = useMemo(() => {
    const t = query.trim().toLowerCase();
    return friends
      .filter((f) => !t || f.username.toLowerCase().includes(t) || (f.displayName ?? "").toLowerCase().includes(t))
      .sort((a, b) => Number(memberIds.has(a.id)) - Number(memberIds.has(b.id))); // people you can still invite first
  }, [friends, query, memberIds]);

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      onNotice("Invite link copied.");
    } catch {
      onNotice(`Copy this link: ${link}`);
    }
  }

  async function send(f: FriendUser) {
    if (!link) return;
    setSent((s) => ({ ...s, [f.id]: { state: "sending" } }));
    try {
      const { results } = await api<SendResults>(`/servers/${server.id}/invites/send`, "POST", { link, userIds: [f.id] });
      const r = results[f.id];
      setSent((s) => ({ ...s, [f.id]: r?.sent ? { state: "sent" } : { state: "failed", reason: r?.reason ?? "Couldn't send the invite." } }));
    } catch (e) {
      setSent((s) => { const next = { ...s }; delete next[f.id]; return next; });
      onError(e);
    }
  }

  return (
    <Modal title={`Invite people to ${server.name}`} onClose={onClose}>
      <div className="stack">
        {friends.length > 0 ? (
          <>
            <label>Send to a friend
              {friends.length > 6 && <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your friends" aria-label="Search your friends" />}
            </label>
            <ul className="plain-list invite-friends">
              {shown.map((f) => {
                const inServer = memberIds.has(f.id);
                const st = sent[f.id];
                return (
                  <li key={f.id}>
                    <span className="invite-friend">
                      <span className="avatar-wrap"><Avatar id={f.id} name={nameOfUser(f)} version={f.avatarVersion} accent={f.accent} size={32} /><StatusDot status={f.status} /></span>
                      <span className="member-name">
                        <span className="member-line"><Name user={f} /></span>
                        <small className="member-status">{st?.state === "failed" ? st.reason : `@${f.username}`}</small>
                      </span>
                    </span>
                    {inServer ? (
                      <small className="muted">In this server</small>
                    ) : st?.state === "sent" ? (
                      <small className="muted">Sent ✓</small>
                    ) : (
                      <button type="button" className="primary" disabled={!link || st?.state === "sending"} onClick={() => void send(f)}>
                        {st?.state === "sending" ? "Sending…" : st?.state === "failed" ? "Try again" : "Invite"}
                      </button>
                    )}
                  </li>
                );
              })}
              {shown.length === 0 && <li><small className="muted">No friends match that.</small></li>}
            </ul>
          </>
        ) : (
          <p className="muted">Your friends will show up here, so you can send them the invite in one tap. For now, share the link below.</p>
        )}
        <hr />
        <label>Or share the invite link
          <span className="invite-link-row">
            <input readOnly value={link || "Making your link…"} onFocus={(e) => e.currentTarget.select()} />
            <button type="button" disabled={!link} onClick={() => void copy()}>Copy</button>
          </span>
        </label>
      </div>
    </Modal>
  );
}
