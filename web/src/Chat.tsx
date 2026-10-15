import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Channel, Message, User } from "./types";
import { fmtSize, hue, MAX_ATTACHMENTS, MAX_FILE_BYTES, QUICK_EMOJI, timeOf } from "./util";

interface Props {
  channel: Channel | undefined;
  me: User;
  items: Message[];
  hasMore: boolean;
  typingNames: string[];
  timeoutUntil: string | null;
  onSend: (content: string, attachmentIds: string[]) => Promise<boolean>;
  onUpload: (file: File) => Promise<Attachment>;
  onReact: (m: Message, emoji: string) => void;
  nameOf: (userId: string) => string;
  onTyping: () => void;
  onLoadOlder: () => void;
}

interface Pending {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  attachment?: Attachment;
}

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");

export default function Chat({ channel, me, items, hasMore, typingNames, timeoutUntil, onSend, onUpload, onReact, nameOf, onTyping, onLoadOlder }: Props) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [picker, setPicker] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const lastTyping = useRef(0);
  const pendingRef = useRef<Pending[]>([]);
  pendingRef.current = pending;

  const timedOut = !!timeoutUntil && new Date(timeoutUntil) > new Date();
  const uploading = pending.some((p) => p.status === "uploading");

  useEffect(() => {
    if (!timeoutUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [timeoutUntil]);

  // Uploads belong to the channel they were made in.
  useEffect(() => {
    setPending([]);
    setPicker(null);
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

  function addFiles(list: FileList | File[]) {
    if (timedOut) return;
    const room = MAX_ATTACHMENTS - pendingRef.current.length;
    const files = [...list].slice(0, Math.max(0, room));
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      if (file.size > MAX_FILE_BYTES) {
        setPending((p) => [...p, { key, name: file.name, size: file.size, status: "error", error: "Larger than 8 MB" }]);
        continue;
      }
      setPending((p) => [...p, { key, name: file.name, size: file.size, status: "uploading" }]);
      onUpload(file).then(
        (attachment) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "ready", attachment } : x))),
        (e) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "error", error: e instanceof Error ? e.message : "Upload failed" } : x)))
      );
    }
  }

  async function submit() {
    const content = text.trim();
    const ready = pending.filter((p) => p.status === "ready");
    if ((!content && !ready.length) || timedOut || uploading) return;
    const snapshot = { text, pending };
    setText("");
    setPending([]);
    stick.current = true;
    if (!(await onSend(content, ready.map((p) => p.attachment!.id)))) {
      setText(snapshot.text);
      setPending(snapshot.pending);
    }
  }

  function onChange(v: string) {
    setText(v);
    const now = Date.now();
    if (v && now - lastTyping.current > 3000) {
      lastTyping.current = now;
      onTyping();
    }
  }

  if (!channel) return <section className="chat empty"><p className="muted">Pick a channel to start talking.</p></section>;

  const scrollIfStuck = () => {
    if (stick.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  };

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
        addFiles(e.dataTransfer.files);
      }}
    >
      <header className="chat-head"><span className="hash">#</span>{channel.name}</header>
      {dragging && <div className="drop-hint">Drop files to attach them to #{channel.name}</div>}
      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {hasMore && <button className="link center-btn" onClick={onLoadOlder}>Load earlier messages</button>}
        {items.length === 0 && <p className="muted pad">No messages in #{channel.name} yet. Say hello.</p>}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const grouped = prev && prev.authorId === m.authorId && new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <div key={m.id} className={grouped ? "msg grouped" : "msg"}>
              {!grouped && <span className="avatar" style={{ background: `hsl(${hue(m.authorName)} 45% 42%)` }}>{m.authorName[0].toUpperCase()}</span>}
              <div className="msg-body">
                {!grouped && (
                  <div className="msg-meta">
                    <strong>{m.authorName}</strong>
                    <time>{timeOf(m.createdAt)}</time>
                  </div>
                )}
                {m.content && <p>{m.content}</p>}
                {m.attachments.length > 0 && (
                  <div className="atts">
                    {m.attachments.map((a) =>
                      a.mime.startsWith("image/") ? (
                        <a key={a.id} href={`/api/files/${a.id}`} target="_blank" rel="noopener noreferrer" title={a.name}>
                          <img src={`/api/files/${a.id}`} alt={a.name} loading="lazy" onLoad={scrollIfStuck} />
                        </a>
                      ) : (
                        <a key={a.id} className="file" href={`/api/files/${a.id}`} download={a.name}>
                          <span className="file-ext">{extOf(a.name)}</span>
                          <span className="file-info"><strong>{a.name}</strong><small>{fmtSize(a.size)}</small></span>
                        </a>
                      )
                    )}
                  </div>
                )}
                {m.reactions.length > 0 && (
                  <div className="reactions">
                    {m.reactions.map((r) => {
                      const mine = r.userIds.includes(me.id);
                      return (
                        <button
                          key={r.emoji}
                          className={mine ? "react mine" : "react"}
                          aria-pressed={mine}
                          disabled={timedOut}
                          title={r.userIds.map(nameOf).join(", ")}
                          onClick={() => onReact(m, r.emoji)}
                        >
                          {r.emoji} <span>{r.userIds.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {!timedOut && (
                <div className={picker === m.id ? "msg-tools open" : "msg-tools"} onClick={(e) => e.stopPropagation()}>
                  <button aria-label="Add reaction" aria-expanded={picker === m.id} onClick={() => setPicker(picker === m.id ? null : m.id)}>☺ +</button>
                  {picker === m.id && (
                    <div className="picker" role="menu">
                      {QUICK_EMOJI.map((e) => (
                        <button key={e} role="menuitem" onClick={() => { onReact(m, e); setPicker(null); }}>{e}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <footer className="composer">
        <div className="typing">
          {typingNames.length > 0 && `${typingNames.slice(0, 3).join(", ")} ${typingNames.length === 1 ? "is" : "are"} typing…`}
        </div>
        {timedOut ? (
          <div className="timeout-note">You're timed out until {timeOf(timeoutUntil!)}. You can read, but not send messages, files, or reactions.</div>
        ) : (
          <>
            {pending.length > 0 && (
              <ul className="pending">
                {pending.map((p) => (
                  <li key={p.key} className={p.status}>
                    <span className="pending-name">{p.name}</span>
                    <small>{p.status === "uploading" ? "Uploading…" : p.status === "error" ? p.error : fmtSize(p.size)}</small>
                    <button className="icon" aria-label={`Remove ${p.name}`} onClick={() => setPending((x) => x.filter((y) => y.key !== p.key))}>✕</button>
                  </li>
                ))}
              </ul>
            )}
            <div className="compose-row">
              <button className="attach" aria-label="Attach files" title="Attach files (or drop or paste them)" disabled={pending.length >= MAX_ATTACHMENTS} onClick={() => fileRef.current?.click()}>📎</button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              <textarea
                rows={1}
                value={text}
                maxLength={2000}
                placeholder={`Message #${channel.name}`}
                onChange={(e) => onChange(e.target.value)}
                onPaste={(e) => {
                  if (e.clipboardData.files.length) {
                    e.preventDefault();
                    addFiles(e.clipboardData.files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            </div>
          </>
        )}
      </footer>
    </section>
  );
}
