import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Channel, Message, User } from "./types";
import { hue, timeOf } from "./util";

interface Props {
  channel: Channel | undefined;
  me: User;
  items: Message[];
  hasMore: boolean;
  typingNames: string[];
  timeoutUntil: string | null;
  onSend: (content: string) => Promise<boolean>;
  onTyping: () => void;
  onLoadOlder: () => void;
}

export default function Chat({ channel, me, items, hasMore, typingNames, timeoutUntil, onSend, onTyping, onLoadOlder }: Props) {
  const [text, setText] = useState("");
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTyping = useRef(0);

  const timedOut = !!timeoutUntil && new Date(timeoutUntil) > new Date();
  useEffect(() => {
    if (!timeoutUntil) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [timeoutUntil]);

  useLayoutEffect(() => {
    const el = listRef.current;
    const last = items[items.length - 1];
    if (el && (stick.current || last?.authorId === me.id)) el.scrollTop = el.scrollHeight;
  }, [items.length, channel?.id]);

  async function submit() {
    const content = text.trim();
    if (!content || timedOut) return;
    setText("");
    stick.current = true;
    if (!(await onSend(content))) setText(content);
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

  return (
    <section className="chat">
      <header className="chat-head"><span className="hash">#</span>{channel.name}</header>
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
                <p>{m.content}</p>
              </div>
            </div>
          );
        })}
      </div>
      <footer className="composer">
        <div className="typing">
          {typingNames.length > 0 && `${typingNames.slice(0, 3).join(", ")} ${typingNames.length === 1 ? "is" : "are"} typing…`}
        </div>
        {timedOut ? (
          <div className="timeout-note">You're timed out until {timeOf(timeoutUntil!)}. You can read, but not send messages.</div>
        ) : (
          <textarea
            rows={1}
            value={text}
            maxLength={2000}
            placeholder={`Message #${channel.name}`}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        )}
      </footer>
    </section>
  );
}
