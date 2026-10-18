import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { api, ApiError, uploadFile } from "./api";
import { Avatar } from "./Avatar";
import Auth from "./Auth";
import Changelog from "./Changelog";
import { hasUnseenUpdates, markUpdatesSeen } from "./changelog";
import Chat from "./Chat";
import { InvitePage } from "./Invites";
import DmPanel from "./DmPanel";
import Members from "./Members";
import { AddServerModal, SettingsModal } from "./Modals";
import { PollModal } from "./Polls";
import { ModerateModal, MyProfileModal, ProfileCard } from "./ProfileModals";
import type { Channel, DmSummary, Member, Message, Poll, Reaction, ServerDetail, ServerSummary, User, Vote } from "./types";
import { actionVerb, fmtDuration, hue, nameOfUser } from "./util";
import VoteBanner from "./VoteBanner";

export default function App() {
  const [me, setMe] = useState<User | null | undefined>(undefined);
  const [inviteCode, setInviteCode] = useState<string | null>(() => /^\/invite\/([A-Za-z0-9_-]{6,32})\/?$/.exec(window.location.pathname)?.[1] ?? null);
  const [openServerId, setOpenServerId] = useState<string | undefined>();
  useEffect(() => {
    api<{ user: User }>("/auth/me").then((r) => setMe(r.user), () => setMe(null));
  }, []);
  if (me === undefined) return <div className="boot">Loading…</div>;
  if (inviteCode) {
    return (
      <InvitePage
        code={inviteCode}
        me={me}
        onAuth={setMe}
        onDone={(serverId) => {
          window.history.replaceState(null, "", "/");
          setOpenServerId(serverId);
          setInviteCode(null);
        }}
      />
    );
  }
  if (!me) return <Auth onAuth={setMe} />;
  return <Main me={me} initialServerId={openServerId} onUser={setMe} onLogout={() => setMe(null)} />;
}

interface Toast { id: number; text: string; error?: boolean }
type MsgState = Record<string, { items: Message[]; hasMore: boolean }>;
type TypingState = Record<string, Record<string, { name: string; until: number }>>;
type Unread = { channels: Record<string, number>; servers: Record<string, number> };
type Modal = "add" | "settings" | "poll" | "myprofile" | "changelog" | null;

function Main({ me, initialServerId, onUser, onLogout }: { me: User; initialServerId?: string; onUser: (u: User) => void; onLogout: () => void }) {
  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ServerDetail | null>(null);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [channelId, setChannelId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<MsgState>({});
  const [typing, setTyping] = useState<TypingState>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [moderating, setModerating] = useState<Member | null>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [unread, setUnread] = useState<Unread>({ channels: {}, servers: {} });
  const [gifsEnabled, setGifsEnabled] = useState(false);
  const [dms, setDms] = useState<DmSummary[]>([]);
  const [unseenUpdates, setUnseenUpdates] = useState(hasUnseenUpdates);
  const [sideMode, setSideMode] = useState<"server" | "dms">("server");

  const socketRef = useRef<Socket | null>(null);
  const meRef = useRef(me);
  const activeIdRef = useRef<string | null>(null);
  const channelIdRef = useRef<string | null>(null);
  const serversRef = useRef<ServerSummary[]>([]);
  const dmsRef = useRef<DmSummary[]>([]);
  meRef.current = me;
  activeIdRef.current = activeId;
  channelIdRef.current = channelId;
  serversRef.current = servers;
  dmsRef.current = dms;

  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const fail = useCallback((e: unknown) => push(e instanceof Error ? e.message : "Something went wrong.", true), [push]);

  const refreshDms = useCallback(() => {
    api<{ dms: DmSummary[] }>("/dms").then((r) => setDms(r.dms), () => {});
  }, []);

  const loadServer = useCallback(async (id: string) => {
    try {
      const { server } = await api<{ server: ServerDetail }>(`/servers/${id}`);
      if (activeIdRef.current !== id) return;
      setDetail(server);
      setVotes((prev) => [...prev.filter((v) => v.status !== "open" && v.serverId === id), ...server.votes]);
      setChannelId((cur) => (cur && server.channels.some((c) => c.id === cur) ? cur : server.channels[0]?.id ?? null));
      setServers((prev) => prev.map((s) => (s.id === id && (s.name !== server.name || s.iconVersion !== server.iconVersion) ? { ...s, name: server.name, iconVersion: server.iconVersion } : s)));
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

  // ---- message state helpers
  const patchMessage = useCallback((channel: string, id: string, fn: (m: Message) => Message) => {
    setMsgs((prev) => {
      const cur = prev[channel];
      if (!cur) return prev;
      let changed = false;
      const items = cur.items.map((m) => {
        if (m.id !== id) return m;
        changed = true;
        return fn(m);
      });
      return changed ? { ...prev, [channel]: { ...cur, items } } : prev;
    });
  }, []);

  const addMessage = useCallback((m: Message) => {
    setMsgs((prev) => {
      const cur = prev[m.channelId];
      if (!cur || cur.items.some((x) => x.id === m.id)) return prev;
      return { ...prev, [m.channelId]: { ...cur, items: [...cur.items, m] } };
    });
  }, []);

  const removeMessage = useCallback((channel: string, id: string) => {
    setMsgs((prev) => {
      const cur = prev[channel];
      if (!cur) return prev;
      // Replies to a deleted message simply lose their quote: no trace is left.
      const items = cur.items.filter((x) => x.id !== id).map((x) => (x.replyTo?.id === id ? { ...x, replyTo: null } : x));
      return { ...prev, [channel]: { ...cur, items } };
    });
    setReplyTo((r) => (r?.id === id ? null : r));
  }, []);

  /** Applies one reaction add/remove. Idempotent, so an optimistic update and its socket echo don't double count. */
  const applyReaction = useCallback((p: { channelId: string; messageId: string; emoji: string; userId: string; added: boolean }) => {
    patchMessage(p.channelId, p.messageId, (m) => {
      const existing = m.reactions.find((r) => r.emoji === p.emoji);
      let reactions: Reaction[];
      if (p.added) {
        if (existing?.userIds.includes(p.userId)) return m;
        reactions = existing
          ? m.reactions.map((r) => (r.emoji === p.emoji ? { ...r, userIds: [...r.userIds, p.userId] } : r))
          : [...m.reactions, { emoji: p.emoji, userIds: [p.userId] }];
      } else {
        if (!existing?.userIds.includes(p.userId)) return m;
        reactions = m.reactions.map((r) => (r.emoji === p.emoji ? { ...r, userIds: r.userIds.filter((u) => u !== p.userId) } : r)).filter((r) => r.userIds.length > 0);
      }
      return { ...m, reactions };
    });
  }, [patchMessage]);

  // ---- initial data
  useEffect(() => {
    api<{ servers: ServerSummary[] }>("/servers").then((r) => {
      setServers(r.servers);
      setActiveId((cur) => cur ?? (r.servers.some((s) => s.id === initialServerId) ? initialServerId! : null) ?? r.servers[0]?.id ?? null);
    }, fail);
    api<{ gifs: boolean }>("/config").then((r) => setGifsEnabled(r.gifs), () => {});
    refreshDms();
  }, [fail, refreshDms]);

  useEffect(() => {
    setDetail(null);
    setVotes([]);
    setChannelId(null);
    setReplyTo(null);
    if (activeId) void loadServer(activeId);
  }, [activeId, loadServer]);

  useEffect(() => {
    setReplyTo(null);
    if (channelId && !msgs[channelId]) void loadMessages(channelId);
  }, [channelId, msgs, loadMessages]);

  // Viewing a channel clears its mention badge.
  const viewedUnread = channelId ? unread.channels[channelId] ?? 0 : 0;
  useEffect(() => {
    if (!channelId || !activeId || !viewedUnread) return;
    setUnread((u) => ({
      channels: { ...u.channels, [channelId]: 0 },
      servers: { ...u.servers, [activeId]: Math.max(0, (u.servers[activeId] ?? 0) - viewedUnread) },
    }));
  }, [channelId, activeId, viewedUnread]);

  const totalUnread = Object.values(unread.servers).reduce((a, b) => a + b, 0);
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Huddle` : "Huddle";
  }, [totalUnread]);

  // ---- realtime
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

    s.on("message.create", (m: Message) => {
      addMessage(m);
      const meId = meRef.current.id;
      const isDm = dmsRef.current.some((d) => d.id === m.serverId);
      if (isDm) setDms((prev) => prev.map((d) => (d.id === m.serverId ? { ...d, lastAt: m.createdAt } : d)).sort((a, b) => b.lastAt.localeCompare(a.lastAt)));
      if (m.authorId === meId || !(isDm || m.mentions.includes(meId) || m.mentionsEveryone)) return;
      if (document.visibilityState === "visible" && m.channelId === channelIdRef.current) return;
      setUnread((u) => ({
        channels: { ...u.channels, [m.channelId]: (u.channels[m.channelId] ?? 0) + 1 },
        servers: { ...u.servers, [m.serverId]: (u.servers[m.serverId] ?? 0) + 1 },
      }));
      push(isDm ? `${m.authorName} sent you a message` : `${m.authorName} mentioned you`);
    });
    s.on("message.update", (m: Message) => patchMessage(m.channelId, m.id, (old) => ({ ...m, poll: old.poll })));
    s.on("message.delete", (p: { channelId: string; messageId: string }) => removeMessage(p.channelId, p.messageId));
    s.on("reaction.update", applyReaction);
    s.on("poll.update", (p: { channelId: string; messageId: string; poll: Poll }) =>
      patchMessage(p.channelId, p.messageId, (m) => (m.poll ? { ...m, poll: { ...p.poll, myVotes: m.poll.myVotes } } : m))
    );
    s.on("typing", (p: { channelId: string; userId: string; username: string }) => {
      setTyping((t) => ({ ...t, [p.channelId]: { ...t[p.channelId], [p.userId]: { name: p.username, until: Date.now() + 4000 } } }));
      setTimeout(() => setTyping((t) => ({ ...t })), 4100);
    });
    s.on("dm.new", (d: DmSummary) => setDms((prev) => (prev.some((x) => x.id === d.id) ? prev : [d, ...prev])));
    s.on("presence", (p: { serverId: string; userId: string; online: boolean }) => {
      setDms((prev) => prev.map((d) => (d.id === p.serverId && d.user.id === p.userId ? { ...d, online: p.online } : d)));
      setDetail((d) =>
        d && d.id === p.serverId
          ? { ...d, members: d.members.map((m) => (m.id === p.userId ? { ...m, online: p.online } : m)).sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username)) }
          : d
      );
    });
    const refresh = (p: { serverId: string }) => {
      if (p.serverId === activeIdRef.current) void loadServer(p.serverId);
    };
    for (const ev of ["member.join", "member.leave", "member.update", "channel.create", "channel.update", "channel.delete", "server.update"]) s.on(ev, refresh);
    s.on("profile.update", (p: { serverId: string; userId: string }) => {
      refresh(p);
      refreshDms();
      if (p.userId === meRef.current.id) api<{ user: User }>("/auth/me").then((r) => onUser(r.user), () => {});
    });

    s.on("server.removed", (p: { serverId: string; reason: string; source?: string }) => {
      const name = serversRef.current.find((x) => x.id === p.serverId)?.name ?? "the server";
      const next = serversRef.current.filter((x) => x.id !== p.serverId);
      setServers(next);
      if (activeIdRef.current === p.serverId) setActiveId(next[0]?.id ?? null);
      const how = p.source === "admin" ? "by an admin" : "by a member vote";
      push(p.reason === "ban" ? `You were banned from ${name} ${how}.` : `You were removed from ${name} ${how}.`, true);
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
  }, [addMessage, applyReaction, loadMessages, loadServer, onUser, patchMessage, push, refreshDms, removeMessage]);

  // ---- actions
  async function send(content: string, attachmentIds: string[], extra: { replyTo?: string; gifUrl?: string }) {
    if (!channelId) return false;
    try {
      const { message } = await api<{ message: Message }>(`/channels/${channelId}/messages`, "POST", { content, attachmentIds, replyTo: extra.replyTo, gifUrl: extra.gifUrl });
      addMessage(message);
      setReplyTo(null);
      return true;
    } catch (e) {
      fail(e);
      if (e instanceof ApiError && e.data?.timeoutUntil && activeId) void loadServer(activeId);
      return false;
    }
  }

  async function editMessage(m: Message, content: string) {
    try {
      const { message } = await api<{ message: Message }>(`/messages/${m.id}`, "PATCH", { content });
      patchMessage(m.channelId, m.id, () => message);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  }

  async function deleteMessage(m: Message) {
    if (!window.confirm("Delete this message? This can't be undone.")) return;
    try {
      await api(`/messages/${m.id}`, "DELETE");
      removeMessage(m.channelId, m.id);
    } catch (e) {
      fail(e);
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

  async function votePoll(m: Message, optionIds: string[]) {
    if (!m.poll) return;
    try {
      const { poll } = await api<{ poll: Poll }>(`/polls/${m.poll.id}/vote`, "PUT", { optionIds });
      patchMessage(m.channelId, m.id, (x) => ({ ...x, poll }));
    } catch (e) {
      fail(e);
    }
  }

  async function closePoll(m: Message) {
    if (!m.poll || !window.confirm("Close this poll? Nobody will be able to vote after.")) return;
    try {
      const { poll } = await api<{ poll: Poll }>(`/polls/${m.poll.id}/close`, "POST");
      patchMessage(m.channelId, m.id, (x) => ({ ...x, poll }));
    } catch (e) {
      fail(e);
    }
  }

  async function createPoll(payload: { question: string; options: string[]; multi: boolean; anonymous: boolean; durationSeconds: number | null }) {
    if (!channelId) return;
    const { message } = await api<{ message: Message }>(`/channels/${channelId}/polls`, "POST", payload);
    addMessage(message);
    setModal(null);
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
    if (!window.confirm(`Start a vote to ${what} ${nameOfUser(m)}?`)) return;
    try {
      const { vote } = await api<{ vote: Vote }>(`/servers/${detail.id}/votes`, "POST", { targetId: m.id });
      setVotes((prev) => (prev.some((x) => x.id === vote.id) ? prev.map((x) => (x.id === vote.id ? { ...x, ...vote } : x)) : [...prev, vote]));
    } catch (e) {
      fail(e);
    }
  }

  /** Joins from an invite embed in chat. Returns the server so the embed can flip to "Open". */
  async function joinInvite(code: string): Promise<ServerSummary | null> {
    try {
      const { server } = await api<{ server: ServerSummary }>("/join", "POST", { code });
      setServers((prev) => (prev.some((x) => x.id === server.id) ? prev : [...prev, server]));
      push(`Joined ${server.name}`);
      return server;
    } catch (e) {
      fail(e);
      return null;
    }
  }

  function openServer(id: string) {
    setSideMode("server");
    setActiveId(id);
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
      const link = `${window.location.origin}/invite/${code}`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      push(`Invite link copied: ${link}`);
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

  async function renameChannel(c: Channel) {
    const name = window.prompt("Rename channel", c.name);
    if (!name || !detail || name === c.name) return;
    try {
      await api(`/servers/${detail.id}/channels/${c.id}`, "PATCH", { name });
    } catch (e) {
      fail(e);
    }
  }

  async function deleteChannel(c: Channel) {
    if (!detail || !window.confirm(`Delete #${c.name}? All of its messages and files will be permanently removed.`)) return;
    try {
      await api(`/servers/${detail.id}/channels/${c.id}`, "DELETE");
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

  async function startDm(userId: string) {
    try {
      const { dm } = await api<{ dm: DmSummary }>("/dms", "POST", { userId });
      setDms((prev) => (prev.some((x) => x.id === dm.id) ? prev.map((x) => (x.id === dm.id ? dm : x)) : [dm, ...prev]));
      setProfileId(null);
      setSideMode("dms");
      setActiveId(dm.id);
    } catch (e) {
      fail(e);
    }
  }

  function openDms() {
    setSideMode("dms");
    if (!dms.some((d) => d.id === activeId)) setActiveId(dms[0]?.id ?? null);
  }

  async function logout() {
    await api("/auth/logout", "POST").catch(() => {});
    socketRef.current?.disconnect();
    onLogout();
  }

  const channel = detail?.channels.find((c) => c.id === channelId);
  const now = Date.now();
  const members = detail?.members ?? [];
  const typingNames = channelId
    ? Object.entries(typing[channelId] ?? {})
        .filter(([id, t]) => id !== me.id && t.until > now)
        .map(([id, t]) => { const m = members.find((x) => x.id === id); return m ? nameOfUser(m) : t.name; })
    : [];
  const isAdmin = detail?.myRole === "owner" || detail?.myRole === "admin";
  const myName = nameOfUser(me);
  const inDm = sideMode === "dms";
  const activeDm = inDm ? dms.find((d) => d.id === activeId) : undefined;
  const dmUnread = dms.reduce((n, d) => n + (unread.servers[d.id] ?? 0), 0);

  return (
    <div className="app">
      <nav className="rail" aria-label="Servers">
        <button className={inDm ? "srv dm-btn active" : "srv dm-btn"} aria-label="Direct messages" title="Direct messages" onClick={openDms}>
          💬{dmUnread > 0 && <span className="badge" aria-label={`${dmUnread} unread`}>{dmUnread}</span>}
        </button>
        <span className="rail-sep" />
        {servers.map((s) => (
          <button
            key={s.id}
            className={s.id === activeId ? "srv active" : "srv"}
            title={s.name}
            aria-label={s.name}
            aria-current={s.id === activeId}
            style={s.iconVersion > 0 ? undefined : { background: `hsl(${hue(s.name)} 38% 40%)` }}
            onClick={() => { setSideMode("server"); setActiveId(s.id); }}
          >
            {s.iconVersion > 0 ? <img src={`/api/servers/${s.id}/icon?v=${s.iconVersion}`} alt="" /> : s.name[0].toUpperCase()}
            {(unread.servers[s.id] ?? 0) > 0 && <span className="badge" aria-label={`${unread.servers[s.id]} mentions`}>{unread.servers[s.id]}</span>}
          </button>
        ))}
        <button className="srv add" aria-label="Add a server" title="Add a server" onClick={() => setModal("add")}>+</button>
      </nav>

      <aside className="side">
        {inDm ? (
          <>
            <header className="side-head"><strong>Direct messages</strong></header>
            <div className="channels">
              {dms.length === 0 && <p className="side-empty">No conversations yet. Open someone's profile or hit Message next to a member to start one.</p>}
              {dms.map((d) => (
                <button key={d.id} className={d.id === activeId ? "chan dm-item active" : "chan dm-item"} onClick={() => setActiveId(d.id)}>
                  <span className="dm-avatar">
                    <Avatar id={d.user.id} name={nameOfUser(d.user)} version={d.user.avatarVersion} accent={d.user.accent} size={28} />
                    <span className={d.online ? "dot on" : "dot"} />
                  </span>
                  <span className="chan-name">{nameOfUser(d.user)}</span>
                  {(unread.servers[d.id] ?? 0) > 0 && <span className="badge inline" aria-label={`${unread.servers[d.id]} unread`}>{unread.servers[d.id]}</span>}
                </button>
              ))}
            </div>
          </>
        ) : detail ? (
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
                <div key={c.id} className="chan-row">
                  <button className={c.id === channelId ? "chan active" : "chan"} onClick={() => setChannelId(c.id)}>
                    <span className="hash">#</span><span className="chan-name">{c.name}</span>
                    {(unread.channels[c.id] ?? 0) > 0 && <span className="badge inline" aria-label={`${unread.channels[c.id]} mentions`}>{unread.channels[c.id]}</span>}
                  </button>
                  {isAdmin && (
                    <span className="chan-tools">
                      <button className="icon" aria-label={`Rename #${c.name}`} title="Rename channel" onClick={() => renameChannel(c)}>✎</button>
                      <button className="icon" aria-label={`Delete #${c.name}`} title="Delete channel" onClick={() => deleteChannel(c)}>✕</button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="side-head"><strong>{servers.length ? "Loading…" : "Huddle"}</strong></div>
        )}
        <footer className="me">
          <button className="me-id" onClick={() => setModal("myprofile")} title="Profile & appearance">
            <Avatar id={me.id} name={myName} version={me.avatarVersion} accent={me.accent} size={28} />
            <span className="me-name">{myName}</span>
          </button>
          <button className="icon whatsnew" aria-label={unseenUpdates ? "What's new (new updates)" : "What's new"} title="What's new" onClick={() => { markUpdatesSeen(); setUnseenUpdates(false); setModal("changelog"); }}>
            ✨{unseenUpdates && <span className="new-dot" />}
          </button>
          {!inDm && detail && detail.myRole !== "owner" && <button className="icon" onClick={leave}>Leave</button>}
          <button className="icon" onClick={logout}>Sign out</button>
        </footer>
      </aside>

      <main className="main">
        {inDm && !activeDm ? (
          <div className="welcome">
            <h2>Direct messages</h2>
            <p className="muted">{dms.length ? "Pick a conversation on the left." : "Open someone's profile in a server and choose Message to start a conversation."}</p>
          </div>
        ) : !inDm && !activeId && servers.length === 0 ? (
          <div className="welcome">
            <h2>Welcome, {myName}</h2>
            <p className="muted">Create a server for your friends, or join one with an invite code.</p>
            <button className="primary" onClick={() => setModal("add")}>Add a server</button>
          </div>
        ) : (
          <>
            {!activeDm && <VoteBanner votes={votes} me={me} onBallot={ballot} />}
            <Chat
              channel={channel}
              dm={activeDm}
              me={me}
              members={members}
              isAdmin={isAdmin}
              items={channelId ? msgs[channelId]?.items ?? [] : []}
              hasMore={channelId ? msgs[channelId]?.hasMore ?? false : false}
              typingNames={typingNames}
              timeoutUntil={detail?.myTimeoutUntil ?? null}
              gifsEnabled={gifsEnabled}
              replyTo={replyTo}
              onReply={setReplyTo}
              onSend={send}
              onUpload={(file) => uploadFile(channelId!, file)}
              onReact={react}
              onEdit={editMessage}
              onDelete={deleteMessage}
              onVotePoll={votePoll}
              onClosePoll={closePoll}
              onOpenPoll={() => setModal("poll")}
              onOpenProfile={setProfileId}
              onTyping={() => channelId && socketRef.current?.emit("typing", { channelId })}
              onJoinInvite={joinInvite}
              onOpenServer={openServer}
              onLoadOlder={() => channelId && msgs[channelId]?.items[0] && void loadMessages(channelId, msgs[channelId].items[0].id)}
            />
          </>
        )}
      </main>

      {activeDm ? (
        <DmPanel dm={activeDm} onChanged={refreshDms} onError={fail} />
      ) : (
        !inDm && detail && <Members server={detail} me={me} votes={votes} onStartVote={startVote} onRole={setRole} onOpenProfile={setProfileId} onModerate={setModerating} onMessage={startDm} />
      )}

      {modal === "add" && (
        <AddServerModal
          onClose={() => setModal(null)}
          onError={fail}
          onDone={(s) => {
            setServers((prev) => (prev.some((x) => x.id === s.id) ? prev : [...prev, s]));
            setSideMode("server");
            setActiveId(s.id);
            setModal(null);
          }}
        />
      )}
      {modal === "settings" && detail && <SettingsModal server={detail} onClose={() => setModal(null)} onError={fail} onSaved={() => { setModal(null); push("Settings saved."); }} />}
      {modal === "poll" && channel && <PollModal channelName={channel.name} onClose={() => setModal(null)} onCreate={createPoll} />}
      {modal === "changelog" && <Changelog onClose={() => setModal(null)} />}
      {modal === "myprofile" && <MyProfileModal me={me} onClose={() => setModal(null)} onUser={onUser} onError={fail} />}
      {profileId && detail && (
        <ProfileCard userId={profileId} serverId={detail.id} meId={me.id} onClose={() => setProfileId(null)} onEdit={() => { setProfileId(null); setModal("myprofile"); }} onMessage={startDm} onChanged={refreshDms} />
      )}
      {moderating && detail && (
        <ModerateModal
          server={detail}
          target={moderating}
          onClose={() => setModerating(null)}
          onError={fail}
          onDone={() => { setModerating(null); push("Done."); void loadServer(detail.id); }}
        />
      )}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={t.error ? "toast err" : "toast"}>{t.text}</div>)}
      </div>
    </div>
  );
}
