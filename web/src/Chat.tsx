import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Composer, { type ComposerHandle } from "./Composer";
import MessageRow from "./MessageRow";
import { Avatar } from "./Avatar";
import { Name } from "./Name";
import type { Attachment, Channel, DmSummary, Member, Message, ServerSummary, User } from "./types";
import { nameOfUser } from "./util";

interface Props {
  channel: Channel | undefined;
  dm?: DmSummary;
  me: User;
  members: Member[];
  canManageMessages: boolean;
  canEveryone: boolean;
  items: Message[];
  hasMore: boolean;
  typingNames: string[];
  timeoutUntil: string | null;
  gifsEnabled: boolean;
  replyTo: Message | null;
  onReply: (m: Message | null) => void;
  onSend: (content: string, attachmentIds: string[], extra: { replyTo?: string; gifUrl?: string; stickerId?: string }) => Promise<boolean>;
  onUpload: (file: File) => Promise<Attachment>;
  onReact: (m: Message, emoji: string) => void;
  onEdit: (m: Message, content: string) => Promise<boolean>;
  onDelete: (m: Message) => void;
  onVotePoll: (m: Message, optionIds: string[]) => void;
  onClosePoll: (m: Message) => void;
  onOpenPoll: () => void;
  onOpenProfile: (userId: string) => void;
  onTyping: () => void;
  onLoadOlder: () => void;
  onJoinInvite: (code: string) => Promise<ServerSummary | null>;
  onOpenServer: (serverId: string) => void;
  navOpen: boolean;
  onToggleNav: () => void;
  showMembersToggle: boolean;
  membersOpen: boolean;
  onToggleMembers: () => void;
}

export default function Chat(p: Props) {
  const { channel, me, members, items } = p;
  const [picker, setPicker] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const stick = useRef(true);

  const byId = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const byName = useMemo(() => new Map(members.map((m) => [m.username.toLowerCase(), m])), [members]);
  const nameOf = (id: string) => { const m = byId.get(id); return m ? nameOfUser(m) : "Someone"; };

  const timedOut = !!p.timeoutUntil && new Date(p.timeoutUntil) > new Date();
  useEffect(() => {
    if (!p.timeoutUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [p.timeoutUntil]);

  useEffect(() => {
    setPicker(null);
    setEditingId(null);
  }, [channel?.id]);

  useEffect(() => {
    if (!picker) return;
    const close = () => setPicker(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [picker]);

  useLayoutEffect(() => {
    const el = listRef.current;
    const last = items[items.length - 1];
    if (el && (stick.current || last?.authorId === me.id)) el.scrollTop = el.scrollHeight;
  }, [items.length, channel?.id]);

  const scrollIfStuck = () => {
    if (stick.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  };

  function jumpTo(id: string) {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
  }

  if (!channel) return <section className="chat empty"><p className="muted">Pick a channel to start talking.</p></section>;

  return (
    <section
      className={dragging ? "chat dragging" : "chat"}
      onDragOver={(e) => {
        if (timedOut || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        composerRef.current?.addFiles(e.dataTransfer.files);
      }}
    >
      <header className="chat-head topbar">
        <button className="icon ghost menu-btn" onClick={p.onToggleNav} aria-label={p.navOpen ? "Hide navigation" : "Show navigation"} aria-expanded={p.navOpen}>☰</button>
        <div className="title">
          {p.dm ? (
            <span className="dm-head">
              <Avatar id={p.dm.user.id} name={nameOfUser(p.dm.user)} version={p.dm.user.avatarVersion} accent={p.dm.user.accent} size={26} />
              <h1><Name user={p.dm.user} /></h1>
              <span className={p.dm.online ? "dot on" : "dot"} title={p.dm.online ? "Online" : "Offline"} />
            </span>
          ) : (
            <><span className="hash">#</span><h1>{channel.name}</h1></>
          )}
        </div>
        <div className="top-actions">
          {p.showMembersToggle && <button className="icon ghost" onClick={p.onToggleMembers} aria-label={p.membersOpen ? "Hide member list" : "Show member list"} aria-expanded={p.membersOpen} title="Members">👥</button>}
        </div>
      </header>
      {dragging && <div className="drop-hint">Drop files to attach them to {p.dm ? nameOfUser(p.dm.user) : `#${channel.name}`}</div>}
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {p.hasMore && <button className="link center-btn" onClick={p.onLoadOlder}>Load earlier messages</button>}
        {items.length === 0 && <p className="muted pad">{p.dm ? `This is the start of your conversation with ${nameOfUser(p.dm.user)}.` : `No messages in #${channel.name} yet. Say hello.`}</p>}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const grouped = !!prev && !m.replyTo && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <MessageRow
              key={m.id}
              m={m}
              grouped={grouped}
              me={me}
              canManage={p.canManageMessages}
              timedOut={timedOut}
              byName={byName}
              byId={byId}
              nameOf={nameOf}
              editing={editingId === m.id}
              pickerOpen={picker === m.id}
              onStartEdit={() => setEditingId(m.id)}
              onCancelEdit={() => setEditingId(null)}
              onSaveEdit={(content) => p.onEdit(m, content)}
              onReply={() => p.onReply(m)}
              onDelete={() => p.onDelete(m)}
              onReact={(emoji) => { p.onReact(m, emoji); setPicker(null); }}
              onTogglePicker={() => setPicker(picker === m.id ? null : m.id)}
              onVote={(ids) => p.onVotePoll(m, ids)}
              onClosePoll={() => p.onClosePoll(m)}
              onOpenProfile={p.onOpenProfile}
              onJumpTo={jumpTo}
              onImageLoad={scrollIfStuck}
              onJoinInvite={p.onJoinInvite}
              onOpenServer={p.onOpenServer}
            />
          );
        })}
      </div>
      <div className="typing">{p.typingNames.length > 0 && `${p.typingNames.slice(0, 3).join(", ")} ${p.typingNames.length === 1 ? "is" : "are"} typing…`}</div>
      <Composer
        ref={composerRef}
        channel={channel}
        me={me}
        members={members}
        canEveryone={p.canEveryone}
        timedOut={timedOut}
        timeoutUntil={p.timeoutUntil}
        replyTo={p.replyTo}
        gifsEnabled={p.gifsEnabled}
        onCancelReply={() => p.onReply(null)}
        onSend={(content, ids, extra) => { stick.current = true; return p.onSend(content, ids, extra); }}
        onUpload={p.onUpload}
        onTyping={p.onTyping}
        onOpenPoll={p.onOpenPoll}
        placeholder={p.dm ? `Message ${nameOfUser(p.dm.user)}` : undefined}
      />
    </section>
  );
}
