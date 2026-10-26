import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import EmojiPicker from "./EmojiPicker";
import GifPicker from "./GifPicker";
import type { Attachment, Channel, Member, Message, User } from "./types";
import { plainPreview } from "./format";
import { Emoji } from "./Rich";
import { searchShortcodes } from "./shortcodes";
import { useServerAssets } from "./ServerAssets";
import { fmtSize, looksLikeVideo, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_VIDEO_BYTES, nameOfUser, timeOf } from "./util";

export interface ComposerHandle { addFiles: (files: FileList | File[]) => void }

interface Props {
  channel: Channel;
  me: User;
  members: Member[];
  canEveryone: boolean;
  timedOut: boolean;
  timeoutUntil: string | null;
  replyTo: Message | null;
  gifsEnabled: boolean;
  onCancelReply: () => void;
  onSend: (content: string, attachmentIds: string[], extra: { replyTo?: string; gifUrl?: string; stickerId?: string }) => Promise<boolean>;
  onUpload: (file: File) => Promise<Attachment>;
  onTyping: () => void;
  onOpenPoll: () => void;
  placeholder?: string;
}

interface Pending { key: string; name: string; size: number; status: "uploading" | "ready" | "error"; error?: string; attachment?: Attachment }
interface Suggestion { key: string; username: string; label: string; emoji?: string }

const STICKER_PANEL = "sticker";

const Composer = forwardRef<ComposerHandle, Props>(function Composer(props, ref) {
  const assets = useServerAssets();
  const { channel, me, members, canEveryone, timedOut, timeoutUntil, replyTo, gifsEnabled, onCancelReply, onSend, onUpload, onTyping, onOpenPoll, placeholder } = props;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [panel, setPanel] = useState<"emoji" | "gif" | "sticker" | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<Pending[]>([]);
  const lastTyping = useRef(0);
  pendingRef.current = pending;

  const uploading = pending.some((p) => p.status === "uploading");

  useEffect(() => {
    setPending([]);
    setPanel(null);
  }, [channel.id]);

  useEffect(() => {
    if (!panel) return;
    const close = () => setPanel(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [panel]);

  function addFiles(list: FileList | File[]) {
    if (timedOut) return;
    const room = MAX_ATTACHMENTS - pendingRef.current.length;
    for (const file of [...list].slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random()}`;
      const video = looksLikeVideo(file);
      if (file.size > (video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) {
        setPending((p) => [...p, { key, name: file.name, size: file.size, status: "error", error: video ? "Videos can be up to 50 MB" : "Larger than 8 MB" }]);
        continue;
      }
      setPending((p) => [...p, { key, name: file.name, size: file.size, status: "uploading" }]);
      onUpload(file).then(
        (attachment) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "ready", attachment } : x))),
        (e) => setPending((p) => p.map((x) => (x.key === key ? { ...x, status: "error", error: e instanceof Error ? e.message : "Upload failed" } : x)))
      );
    }
  }
  useImperativeHandle(ref, () => ({ addFiles }));

  // ---- @mention autocomplete
  const mentionQuery = useMemo(() => {
    const before = text.slice(0, caret);
    const m = /(?:^|\s)@([A-Za-z0-9_]{0,20})$/.exec(before);
    return m ? { query: m[1], start: before.length - m[1].length - 1 } : null;
  }, [text, caret]);

  // ---- :emoji shortcode autocomplete (after at least two characters, and only at the start of a word)
  const emojiQuery = useMemo(() => {
    const before = text.slice(0, caret);
    const m = /(?:^|[\s(])(:[A-Za-z0-9_+-]{2,})$/.exec(before);
    return m ? { query: m[1].slice(1), start: before.length - m[1].length } : null;
  }, [text, caret]);

  const suggestions: Suggestion[] = useMemo(() => {
    if (mentionQuery) {
      if (dismissed === `${mentionQuery.start}:${mentionQuery.query}`) return [];
      const q = mentionQuery.query.toLowerCase();
      const list: Suggestion[] = members
        .filter((m) => m.id !== me.id && (m.username.toLowerCase().startsWith(q) || (m.displayName ?? "").toLowerCase().startsWith(q)))
        .slice(0, 6)
        .map((m) => ({ key: m.id, username: m.username, label: nameOfUser(m) }));
      if (canEveryone && "everyone".startsWith(q)) list.push({ key: "everyone", username: "everyone", label: "Notify everyone" });
      return list;
    }
    if (emojiQuery && dismissed !== `:${emojiQuery.start}:${emojiQuery.query}`) {
      const ql = emojiQuery.query.toLowerCase();
      const custom = assets.emojis.filter((e) => e.name.toLowerCase().includes(ql)).slice(0, 5).map((e) => ({ key: `custom:${e.id}`, username: "", label: `:${e.name}:`, emoji: `<:${e.name}:${e.id}>` }));
      return [...custom, ...searchShortcodes(emojiQuery.query).map((e) => ({ key: `emoji:${e.name}`, username: "", label: `:${e.name}:`, emoji: e.glyph }))].slice(0, 8);
    }
    return [];
  }, [mentionQuery, emojiQuery, dismissed, members, me.id, canEveryone, assets.emojis]);

  useEffect(() => setSel(0), [mentionQuery?.query, emojiQuery?.query]);

  function insertMention(s: Suggestion) {
    if (!mentionQuery) return;
    const before = text.slice(0, mentionQuery.start);
    const after = text.slice(caret);
    const next = `${before}@${s.username} ${after}`;
    const pos = before.length + s.username.length + 2;
    setText(next);
    setCaret(pos);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  }

  /** Picks a suggestion: a @mention, or an emoji that replaces the :partial_name being typed. */
  function acceptSuggestion(s: Suggestion) {
    if (!s.emoji) return insertMention(s);
    if (!emojiQuery) return;
    const before = text.slice(0, emojiQuery.start);
    const after = text.slice(caret);
    const pos = before.length + s.emoji.length + 1;
    setText(`${before}${s.emoji} ${after}`);
    setCaret(pos);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  }

  function insertEmoji(emoji: string) {
    const pos = taRef.current?.selectionStart ?? text.length;
    const next = text.slice(0, pos) + emoji + text.slice(pos);
    setText(next);
    setPanel(null);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos + emoji.length, pos + emoji.length);
    });
  }

  async function submit() {
    const content = text.trim();
    const ready = pending.filter((p) => p.status === "ready");
    if ((!content && !ready.length) || timedOut || uploading) return;
    const snapshot = { text, pending };
    setText("");
    setPending([]);
    if (!(await onSend(content, ready.map((p) => p.attachment!.id), { replyTo: replyTo?.id }))) {
      setText(snapshot.text);
      setPending(snapshot.pending);
    }
  }

  function onChange(el: HTMLTextAreaElement) {
    setText(el.value);
    setCaret(el.selectionStart);
    const now = Date.now();
    if (el.value && now - lastTyping.current > 3000) {
      lastTyping.current = now;
      onTyping();
    }
  }

  if (timedOut) {
    return (
      <footer className="composer">
        <div className="timeout-note">You're timed out until {timeOf(timeoutUntil!)}. You can read, but not send messages, files, or reactions.</div>
      </footer>
    );
  }

  return (
    <footer className="composer">
      {replyTo && (
        <div className="reply-bar">
          <span>Replying to <strong>{replyTo.authorName}</strong></span>
          <span className="reply-snippet">{plainPreview(replyTo.content).slice(0, 80) || "an attachment"}</span>
          <button className="icon" aria-label="Cancel reply" onClick={onCancelReply}>✕</button>
        </div>
      )}
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
        <button className="tool" aria-label="Attach files" title="Attach files (or drop or paste them)" disabled={pending.length >= MAX_ATTACHMENTS} onClick={() => fileRef.current?.click()}>📎</button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
        <div className="ta-wrap">
          {suggestions.length > 0 && (
            <ul className="suggest" role="listbox">
              {suggestions.map((s, i) => (
                <li key={s.key} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); acceptSuggestion(s); }}>
                  {s.emoji ? (
                    <><Emoji emoji={s.emoji} /> <strong>{s.label}</strong></>
                  ) : (
                    <><strong>{s.label}</strong> <small>@{s.username}</small></>
                  )}
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            maxLength={2000}
            placeholder={placeholder ?? `Message #${channel.name}`}
            onChange={(e) => onChange(e.currentTarget)}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (suggestions.length) {
                if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % suggestions.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + suggestions.length) % suggestions.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSuggestion(suggestions[sel]); return; }
                if (e.key === "Escape") { e.preventDefault(); setDismissed(mentionQuery ? `${mentionQuery.start}:${mentionQuery.query}` : `:${emojiQuery!.start}:${emojiQuery!.query}`); return; }
              }
              if (e.key === "Escape" && replyTo) { onCancelReply(); return; }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </div>
        <div className="tool-wrap" onClick={(e) => e.stopPropagation()}>
          <button className="tool" aria-label="Create a poll" title="Create a poll" onClick={onOpenPoll}>📊</button>
        </div>
        {gifsEnabled && (
          <div className="tool-wrap" onClick={(e) => e.stopPropagation()}>
            <button className="tool gif-btn" aria-label="Send a GIF" aria-expanded={panel === "gif"} onClick={() => setPanel(panel === "gif" ? null : "gif")}>GIF</button>
            {panel === "gif" && (
              <GifPicker onPick={async (gifUrl) => { setPanel(null); await onSend("", [], { gifUrl, replyTo: replyTo?.id }); }} />
            )}
          </div>
        )}
        <div className="tool-wrap" onClick={(e) => e.stopPropagation()}>
          {assets.stickers.length > 0 && (
            <span className="tool-wrap" onClick={(e) => e.stopPropagation()}>
              <button className="tool" aria-label="Send a sticker" title="Stickers" aria-expanded={panel === STICKER_PANEL} onClick={() => setPanel(panel === STICKER_PANEL ? null : STICKER_PANEL)}>🏷</button>
              {panel === STICKER_PANEL && (
                <div className="picker up sticker-picker" role="menu">
                  {assets.stickers.map((s) => (
                    <button key={s.id} role="menuitem" title={s.name} aria-label={s.name} onClick={async () => { setPanel(null); await onSend("", [], { stickerId: s.id, replyTo: replyTo?.id }); }}>
                      <img src={`/api/stickers/${s.id}`} alt={s.name} loading="lazy" />
                    </button>
                  ))}
                </div>
              )}
            </span>
          )}
          <button className="tool" aria-label="Add emoji" aria-expanded={panel === "emoji"} onClick={() => setPanel(panel === "emoji" ? null : "emoji")}>☺</button>
          {panel === "emoji" && <EmojiPicker className="up" onPick={insertEmoji} />}
        </div>
      </div>
    </footer>
  );
});

export default Composer;
