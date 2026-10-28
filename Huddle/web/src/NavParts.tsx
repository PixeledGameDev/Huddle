import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "./Popover";
import { api } from "./api";
import { Avatar } from "./Avatar";
import { Name } from "./Name";
import { StatusDot } from "./Status";
import type { FriendUser } from "./types";
import { nameOfUser } from "./util";

interface FriendsData { friends: FriendUser[]; incoming: FriendUser[]; outgoing: FriendUser[] }

/** The Friends tab of the navigation panel: requests waiting for you, then everyone online, then everyone else. */
export function FriendsPanel({ data, onOpenProfile, onMessage, onError, onOpenFull }: { data: FriendsData; onOpenProfile: (id: string) => void; onMessage: (id: string) => void; onError: (e: unknown) => void; onOpenFull: () => void }) {
  const online = data.friends.filter((f) => f.status !== "offline");
  const offline = data.friends.filter((f) => f.status === "offline");
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { onError(e); } };
  const row = (u: FriendUser, actions?: React.ReactNode) => (
    <li key={u.id} className="friend-row">
      <button className="chan" onClick={() => onOpenProfile(u.id)}>
        <span className="avatar-wrap"><Avatar id={u.id} name={nameOfUser(u)} version={u.avatarVersion} accent={u.accent} size={30} /><StatusDot status={u.status} /></span>
        <span className="who"><strong><Name user={u} /></strong><small>{u.statusText || `@${u.username}`}</small></span>
      </button>
      {actions}
    </li>
  );
  return (
    <div className="channels friends-panel">
      <button className="pill sm" onClick={onOpenFull}>Add friends or manage requests</button>
      {data.incoming.length > 0 && (
        <>
          <h3 className="group">Requests · {data.incoming.length}</h3>
          <ul className="list">{data.incoming.map((u) => row(u, (
            <span className="friend-actions">
              <button className="pill primary sm" onClick={() => void run(() => api(`/friends/requests/${u.id}/accept`, "POST"))}>Accept</button>
              <button className="pill sm" onClick={() => void run(() => api(`/friends/requests/${u.id}`, "DELETE"))}>Decline</button>
            </span>
          )))}</ul>
        </>
      )}
      {online.length > 0 && (<><h3 className="group">Online · {online.length}</h3><ul className="list">{online.map((u) => row(u, <button className="icon ghost" aria-label={`Message ${nameOfUser(u)}`} title="Message" onClick={() => onMessage(u.id)}>💬</button>))}</ul></>)}
      {offline.length > 0 && (<><h3 className="group">Offline · {offline.length}</h3><ul className="list dim">{offline.map((u) => row(u, <button className="icon ghost" aria-label={`Message ${nameOfUser(u)}`} title="Message" onClick={() => onMessage(u.id)}>💬</button>))}</ul></>)}
      {data.friends.length === 0 && data.incoming.length === 0 && <p className="side-empty">No friends yet. Open someone's profile and choose Add friend.</p>}
    </div>
  );
}

export interface MenuItem { label: string; onClick?: () => void; href?: string; danger?: boolean; hint?: string }

/** The ⋯ button in the bottom-left corner: everything that used to be a row of small buttons. */
export function MoreMenu({ items, badge }: { items: MenuItem[]; badge?: boolean }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="status-menu">
      <button ref={btn} className="icon ghost more-btn" aria-haspopup="menu" aria-expanded={open} aria-label="More" title="More" onClick={() => setOpen((o) => !o)}>⋯{badge && <span className="new-dot" />}</button>
      {open && (
        <Popover anchor={btn} onClose={close} width={260} className="more-menu" label="More">
          {items.map((it) => it.href ? (
            <a key={it.label} role="menuitem" className="menu-item" href={it.href} target="_blank" rel="noopener" onClick={close}><span><strong>{it.label}</strong>{it.hint && <small>{it.hint}</small>}</span></a>
          ) : (
            <button key={it.label} role="menuitem" className={it.danger ? "menu-item danger" : "menu-item"} onClick={() => { setOpen(false); it.onClick?.(); }}><span><strong>{it.label}</strong>{it.hint && <small>{it.hint}</small>}</span></button>
          ))}
        </Popover>
      )}
    </div>
  );
}
