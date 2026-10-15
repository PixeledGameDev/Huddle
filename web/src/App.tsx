import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api, ApiError, uploadFile } from "./api";
import Auth from "./Auth";
import Chat from "./Chat";
import Members from "./Members";
import { AddServerModal, SettingsModal } from "./Modals";
import type { Member, Message, Reaction, ServerDetail, ServerSummary, User, Vote } from "./types";
import { actionVerb, fmtDuration, hue } from "./util";
import VoteBanner from "./VoteBanner";

export default function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api<{ user: User }>("/auth/me").then((r) => setMe(r.user), () => setMe(null));
  }, []);
  if (me === undefined) return <div className="boot">Loading…</div>;
  if (!me) return <Auth onAuth={setMe} />;
  return <Main me={me} onLogout={() => setMe(null)} />;
}

interface Toast { id: number; text: string; error?: boolean }
type MsgState = Record<string, { items: Message[]; hasMore: boolean }>;
type TypingState = Record<string, Record<string, { name: string; until: number }>>;

function Main({ me, onLogout }: { me: User; onLogout: () => void }) {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<MsgState>({});
  const [typing, setTyping] = useState<TypingState>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<"add" | "settings" | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const channelIdRef = useRef<string | null>(null);
  const serversRef = useRef<ServerSummary[]>([]);
  activeIdRef.current = activeId;
  channelIdRef.current = channelId;
  serversRef.current = servers;

  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const fail = useCallback((e: unknown) => push(e instanceof Error ? e.message : "Something went wrong.", true), [push]);

  const loadServer = useCallback(async (id: string) => {
    try {
      const { server } = await api<{ server: ServerDetail }>(`/servers/${id}`);
      if (activeIdRef.current !== id) return;
      setDetail(server);
      setVotes((prev) => [...prev.filter((v) => v.status !== "open" && v.serverId === id), ...server.votes]);
      setChannelId((cur) => (cur && server.channels.some((c) => c.id === cur) ? cur : server.channels[0]?.id ?? null));
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const loadMessages = useCallback(async (cid: string, before?: string) => {
    try {
      const r = await api<{ messages: Message[]; hasMore: boolean }>(`/channels/${cid}/messages${before ? `?before=${before}` : ""}`);
      setMsgs((prev) => {
        const cur = prev[cid]?.items ?? [];
        return { ...prev, [cid]: { items: before ? [...r.messages, ...cur] : r.messages, hasMore: r.hasMore } };
      });
    } catch (e) {
      fail(e);
    }
  }, [fail]);

  const addMessage = useCallback((m: Message) => {
    setMsgs((prev) => {
      const cur = prev[m.channelId];
      if (!cur || cur.items.some((x) => x.id === m.id)) return prev;
      return { ...prev, [m.channelId]: { ...cur, items: [...cur.items, m] } };
    });
  }, []);

  /** Applies one reaction add/remove. Idempotent, so an optimistic update and its socket echo don't double count. */
  const applyReaction = useCallback((p: { channelId: string; messageId: string; emoji: string; userId: string; added: boolean }) => {
    setMsgs((prev) => {
      const cur = prev[p.channelId];
      if (!cur) return prev;
      let changed = false;
      const items = cur.items.map((m) => {
        if (m.id !== p.messageId) return m;
        const existing = m.reactions.find((r) => r.emoji === p.emoji);
        let reactions: Reaction[];
        if (p.added) {
          if (existing?.userIds.includes(p.userId)) return m;
          reactions = existing
            ? m.reactions.map((r) => (r.emoji === p.emoji ? { ...r, userIds: [...r.userIds, p.userId] } : r))
            : [...m.reactions, { emoji: p.emoji, userIds: [p.userId] }];
        } else {
          if (!existing?.userIds.includes(p.userId)) return m;
          reactions = m.reactions
            .map((r) => (r.emoji === p.emoji ? { ...r, userIds: r.userIds.filter((u) => u !== p.userId) } : r))
            .filter((r) => r.userIds.length > 0);
        }
        changed = true;
        return { ...m, reactions };
      });
      return changed ? { ...prev, [p.channelId]: { ...cur, items } } : prev;
    });
  }, []);

  // Initial server list
  useEffect(() => {
    api<{ servers: ServerSummary[] }>("/servers").then((r) => {
      setServers(r.servers);
      setActiveId((cur) => cur ?? r.servers[0]?.id ?? null);
    }, fail);
  }, [fail]);

  useEffect(() => {
    setDetail(null);
    setVotes([]);
    setChannelId(null);
    if (activeId) void loadServer(activeId);
  }, [activeId, loadServer]);

  useEffect(() => {
    if (channelId && !msgs[channelId]) void loadMessages(channelId);
  }, [channelId, msgs, loadMessages]);

  // Realtime
  useEffect(() => {
    const s = io({ withCredentials: true });
    socketRef.current = s;
    let connectedBefore = false;

    s.on("connect", () => {
      if (connectedBefore) {
        // Reconnected: catch up on anything missed while offline.
        if (activeIdRef.current) void loadServer(activeIdRef.current);
        if (channelIdRef.current) void loadMessages(channelIdRef.current);
      }
      connectedBefore = true;
    });
    s.on("message.create", addMessage);
    s.on("reaction.update", applyReaction);
    s.on("typing", (p: { channelId: string; userId: string; username: string }) => {
      setTyping((t) => ({ ...t, [p.channelId]: { ...t[p.channelId], [p.userId]: { name: p.username, until: Date.now() + 4000 } } }));
      setTimeout(() => setTyping((t) => ({ ...t })), 4100);
    });
    s.on("presence", (p: { serverId: string; userId: string; online: boolean }) => {
      setDetail((d) =>
        d && d.id === p.serverId
          ? { ...d, members: d.members.map((m) => (m.id === p.userId ? { ...m, online: p.online } : m)).sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username)) }
          : d
      );
    });
    const refresh = (p: { serverId: string }) => {
      if (p.serverId === activeIdRef.current) void loadServer(p.serverId);
    };
    for (const ev of ["member.join", "member.leave", "member.update", "channel.create", "server.update"]) s.on(ev, refresh);

    s.on("server.removed", (p: { serverId: string; reason: string }) => {
      const name = serversRef.current.find((x) => x.id === p.serverId)?.name ?? "the server";
      const next = serversRef.current.filter((x) => x.id !== p.serverId);
      setServers(next);
      if (activeIdRef.current === p.serverId) setActiveId(next[0]?.id ?? null);
      push(p.reason === "ban" ? `You were banned from ${name} by a member vote.` : `You were removed from ${name} by a member vote.`, true);
    });

    s.on("vote.update", (v: Vote) => {
      if (v.serverId !== activeIdRef.current) return;
      setVotes((prev) => {
        const old = prev.find((x) => x.id === v.id);
        const merged: Vote = { ...v, myVote: v.myVote ?? old?.myVote ?? null };
        return old ? prev.map((x) => (x.id === v.id ? merged : x)) : [...prev, merged];
      });
      if (v.status !== "open") {
        setTimeout(() => setVotes((prev) => prev.filter((x) => x.id !== v.id)), 8000);
        if (v.status === "passed" && v.action === "timeout") void loadServer(v.serverId);
      }
    });

    return () => {
      s.disconnect();
    };
  }, [addMessage, applyReaction, loadMessages, loadServer, push]);

  async function send(content: string, attachmentIds: string[]) {
    if (!channelId) return false;
    try {
      const { message } = await api<{ message: Message }>(`/channels/${channelId}/messages`, "POST", { content, attachmentIds });
      addMessage(message);
      return true;
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.data?.timeoutUntil && activeId) void loadServer(activeId);
      return false;
    }
  }

  async function react(m: Message, emoji: string) {
    const had = !!m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me.id);
    const delta = { channelId: m.channelId, messageId: m.id, emoji, userId: me.id };
    applyReaction({ ...delta, added: !had }); // optimistic
    try {
      await api(`/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`, had ? "DELETE" : "PUT");
    } catch (e) {
      applyReaction({ ...delta, added: had }); // roll back
      fail(e);
    }
  }

  async function ballot(v: Vote, choice: boolean) {
    try {
      const { vote } = await api<{ vote: Vote }>(`/votes/${v.id}/ballot`, "POST", { choice });
      setVotes((prev) => prev.map((x) => (x.id === vote.id ? { ...x, ...vote } : x)));
    } catch (e) {
      fail(e);
    }
  }

  async function startVote(m: Member) {
    if (!detail) return;
    const st = detail.settings;
    const what = st.voteAction === "kick" ? "kick" : `${actionVerb(st.voteAction)} for ${fmtDuration(st.voteDurationSeconds)}`;
    if (!window.confirm(`Start a vote to ${what} ${m.username}?`)) return;
    try {
      const { vote } = await api<{ vote: Vote }>(`/servers/${detail.id}/votes`, "POST", { targetId: m.id });
      setVotes((prev) => (prev.some((x) => x.id === vote.id) ? prev.map((x) => (x.id === vote.id ? { ...x, ...vote } : x)) : [...prev, vote]));
    } catch (e) {
      fail(e);
    }
  }

  async function setRole(m: Member, role: "admin" | "member") {
    if (!detail) return;
    try {
      await api(`/servers/${detail.id}/members/${m.id}/role`, "POST", { role });
    } catch (e) {
      fail(e);
    }
  }

  async function invite() {
    if (!detail) return;
    try {
      const { code } = await api<{ code: string }>(`/servers/${detail.id}/invites`, "POST");
      await navigator.clipboard?.writeText(code).catch(() => {});
      push(`Invite code ${code} (copied). Share it so others can join.`);
    } catch (e) {
      fail(e);
    }
  }

  async function addChannel() {
    const name = window.prompt("Channel name");
    if (!name || !detail) return;
    try {
      await api(`/servers/${detail.id}/channels`, "POST", { name });
    } catch (e) {
      fail(e);
    }
  }

  async function leave() {
    if (!detail || !window.confirm(`Leave ${detail.name}?`)) return;
    try {
      await api(`/servers/${detail.id}/leave`, "POST");
      const next = servers.filter((s) => s.id !== detail.id);
      setServers(next);
      setActiveId(next[0]?.id ?? null);
    } catch (e) {
      fail(e);
    }
  }

  async function logout() {
    await api("/auth/logout", "POST").catch(() => {});
    socketRef.current?.disconnect();
    onLogout();
  }

  const channel = detail?.channels.find((c) => c.id === channelId);
  const now = Date.now();
  const typingNames = channelId ? Object.entries(typing[channelId] ?? {}).filter(([id, t]) => id !== me.id && t.until > now).map(([, t]) => t.name) : [];
  const isAdmin = detail?.myRole === "owner" || detail?.myRole === "admin";

  return (
    <div className="app">
      <nav className="rail" aria-label="Servers">
        {servers.map((s) => (
          <button
            key={s.id}
            className={s.id === activeId ? "srv active" : "srv"}
            title={s.name}
            aria-label={s.name}
            aria-current={s.id === activeId}
            style={{ background: `hsl(${hue(s.name)} 38% 40%)` }}
            onClick={() => setActiveId(s.id)}
          >
            {s.name[0].toUpperCase()}
          </button>
        ))}
        <button className="srv add" aria-label="Add a server" title="Add a server" onClick={() => setModal("add")}>+</button>
      </nav>

      <aside className="side">
        {detail ? (
          <>
            <header className="side-head">
              <strong title={detail.name}>{detail.name}</strong>
              <span>
                <button className="icon" title="Copy an invite code" onClick={invite}>Invite</button>
                {isAdmin && <button className="icon" title="Server settings" onClick={() => setModal("settings")}>Settings</button>}
              </span>
            </header>
            <div className="channels">
              <div className="side-label">
                Channels
                {isAdmin && <button className="icon" aria-label="New channel" onClick={addChannel}>+</button>}
              </div>
              {detail.channels.map((c) => (
                <button key={c.id} className={c.id === channelId ? "chan active" : "chan"} onClick={() => setChannelId(c.id)}>
                  <span className="hash">#</span>{c.name}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="side-head"><strong>{servers.length ? "Loading…" : "Huddle"}</strong></div>
        )}
        <footer className="me">
          <span className="avatar sm" style={{ background: `hsl(${hue(me.username)} 45% 42%)` }}>{me.username[0].toUpperCase()}</span>
          <span className="me-name">{me.username}</span>
          {detail && detail.myRole !== "owner" && <button className="icon" onClick={leave}>Leave</button>}
          <button className="icon" onClick={logout}>Sign out</button>
        </footer>
      </aside>

      <main className="main">
        {!activeId && servers.length === 0 ? (
          <div className="welcome">
            <h2>Welcome, {me.username}</h2>
            <p className="muted">Create a server for your friends, or join one with an invite code.</p>
            <button className="primary" onClick={() => setModal("add")}>Add a server</button>
          </div>
        ) : (
          <>
            <VoteBanner votes={votes} me={me} onBallot={ballot} />
            <Chat
              channel={channel}
              me={me}
              items={channelId ? msgs[channelId]?.items ?? [] : []}
              hasMore={channelId ? msgs[channelId]?.hasMore ?? false : false}
              typingNames={typingNames}
              timeoutUntil={detail?.myTimeoutUntil ?? null}
              onSend={send}
              onUpload={(file) => uploadFile(channelId!, file)}
              onReact={react}
              nameOf={(id) => detail?.members.find((x) => x.id === id)?.username ?? "Someone"}
              onTyping={() => channelId && socketRef.current?.emit("typing", { channelId })}
              onLoadOlder={() => channelId && msgs[channelId]?.items[0] && void loadMessages(channelId, msgs[channelId].items[0].id)}
            />
          </>
        )}
      </main>

      {detail && <Members server={detail} me={me} votes={votes} onStartVote={startVote} onRole={setRole} />}

      {modal === "add" && (
        <AddServerModal
          onClose={() => setModal(null)}
          onError={fail}
          onDone={(s) => {
            setServers((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]));
            setActiveId(s.id);
            setModal(null);
          }}
        />
      )}
      {modal === "settings" && detail && (
        <SettingsModal
          server={detail}
          onClose={() => setModal(null)}
          onError={fail}
          onSaved={() => {
            setModal(null);
            push("Settings saved.");
          }}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={t.error ? "toast err" : "toast"}>{t.text}</div>)}
      </div>
    </div>
  );
}
