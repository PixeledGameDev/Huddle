import { useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import Auth from "./Auth";
import { hue } from "./util";
import type { ServerSummary, User } from "./types";

export interface InviteInfo { name: string; iconVersion: number; memberCount: number; onlineCount: number; joined: boolean; serverId?: string }

const cache = new Map<string, { at: number; p: Promise<InviteInfo> }>();
export function fetchInvite(code: string, fresh = false): Promise<InviteInfo> {
  const hit = cache.get(code);
  if (!fresh && hit && Date.now() - hit.at < 30_000) return hit.p;
  const p = api<InviteInfo>(`/invites/${code}`);
  cache.set(code, { at: Date.now(), p });
  p.catch(() => cache.delete(code));
  return p;
}

/** The card itself: server icon, name, and counts, with an action slot. */
export function InviteCard({ info, code, action, label = "You've been invited to join" }: { info: InviteInfo; code: string; action?: ReactNode; label?: string }) {
  const [badIcon, setBadIcon] = useState(false);
  return (
    <div className="invite-card">
      <small className="muted">{label}</small>
      <div className="invite-row">
        {info.iconVersion > 0 && !badIcon ? (
          <img className="invite-icon" src={`/api/invites/${code}/icon?v=${info.iconVersion}`} alt="" onError={() => setBadIcon(true)} />
        ) : (
          <span className="invite-icon" style={{ background: `hsl(${hue(info.name)} 38% 40%)` }}>{info.name[0]?.toUpperCase()}</span>
        )}
        <div className="invite-text">
          <strong title={info.name}>{info.name}</strong>
          <small className="muted">
            {info.onlineCount > 0 && <><span className="dot on inline" /> {info.onlineCount} online · </>}
            {info.memberCount} {info.memberCount === 1 ? "member" : "members"}
          </small>
        </div>
        {action}
      </div>
    </div>
  );
}

/** Shown under a message that contains an invite link to this app. */
export function InviteEmbed({ code, onJoin, onOpen }: { code: string; onJoin: (code: string) => Promise<ServerSummary | null>; onOpen: (serverId: string) => void }) {
  const [info, setInfo] = useState<InviteInfo | "invalid" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetchInvite(code).then((i) => live && setInfo(i), () => live && setInfo("invalid"));
    return () => { live = false; };
  }, [code]);

  if (info === null) return <div className="invite-card muted">Loading invite…</div>;
  if (info === "invalid") return <div className="invite-card muted">This invite is invalid.</div>;

  const action = info.joined && info.serverId ? (
    <button onClick={() => onOpen(info.serverId!)}>Open</button>
  ) : (
    <button
      className="primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const s = await onJoin(code);
        setBusy(false);
        if (s) {
          cache.delete(code);
          setInfo({ ...info, joined: true, serverId: s.id, memberCount: info.memberCount + 1 });
        }
      }}
    >
      Join
    </button>
  );
  return <InviteCard info={info} code={code} action={action} />;
}

/** The full page at /invite/<code>. Works before signing in: the card shows above the sign-in form. */
export function InvitePage({ code, me, onAuth, onDone }: { code: string; me: User | null; onAuth: (u: User) => void; onDone: (serverId?: string) => void }) {
  const [info, setInfo] = useState<InviteInfo | "invalid" | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setInfo(null);
    fetchInvite(code, true).then(setInfo, () => setInfo("invalid"));
  }, [code, me?.id]);

  if (info === null) return <div className="boot">Loading…</div>;
  if (info === "invalid") {
    return (
      <main className="auth">
        <div className="auth-card">
          <h1>Invite not found</h1>
          <p className="muted">This invite link is invalid. Ask the person who sent it for a new one.</p>
          <button className="primary" onClick={() => onDone()}>Go to Huddle</button>
        </div>
      </main>
    );
  }
  if (!me) return <Auth onAuth={onAuth} intro={<InviteCard info={info} code={code} />} />;

  async function join() {
    setBusy(true);
    setError("");
    try {
      const { server } = await api<{ server: ServerSummary }>("/join", "POST", { code });
      onDone(server.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join.");
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <InviteCard info={info} code={code} />
        {error && <p className="error" role="alert">{error}</p>}
        {info.joined ? (
          <button className="primary" onClick={() => onDone(info.serverId)}>You're already in. Open it</button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void join()}>Join {info.name}</button>
        )}
        <button className="link" onClick={() => onDone()}>Not now</button>
      </div>
    </main>
  );
}
