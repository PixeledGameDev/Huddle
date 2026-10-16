import { useState } from "react";
import { Avatar } from "./Avatar";
import EmojiPicker from "./EmojiPicker";
import { PollCard } from "./Polls";
import { Emoji, RichText } from "./Rich";
import type { Member, Message, User } from "./types";
import { fmtSize, nameOfUser, timeOf } from "./util";

interface Props {
  m: Message;
  grouped: boolean;
  me: User;
  isAdmin: boolean;
  timedOut: boolean;
  byName: Map<string, Member>;
  byId: Map<string, Member>;
  editing: boolean;
  pickerOpen: boolean;
  nameOf: (id: string) => string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (content: string) => Promise<boolean>;
  onReply: () => void;
  onDelete: () => void;
  onReact: (emoji: string) => void;
  onTogglePicker: () => void;
  onVote: (optionIds: string[]) => void;
  onClosePoll: () => void;
  onOpenProfile: (userId: string) => void;
  onJumpTo: (id: string) => void;
  onImageLoad: () => void;
}

const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE");

function EditBox({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => Promise<boolean>; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (busy) return;
    if (v.trim() === initial) return onCancel();
    setBusy(true);
    if (await onSave(v)) onCancel();
    else setBusy(false);
  }
  return (
    <div className="edit-box">
      <textarea
        autoFocus
        value={v}
        maxLength={2000}
        rows={Math.min(8, v.split("\n").length + 1)}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); }
        }}
      />
      <small className="muted">Escape to <button className="link" onClick={onCancel}>cancel</button> · Enter to <button className="link" onClick={() => void save()}>save</button></small>
    </div>
  );
}

export default function MessageRow(p: Props) {
  const { m, grouped, me, isAdmin, timedOut, byName, byId } = p;
  const author = byId.get(m.authorId);
  const authorName = author ? nameOfUser(author) : m.authorName;
  const mentionedMe = m.authorId !== me.id && (m.mentions.includes(me.id) || m.mentionsEveryone);
  const replyAuthor = m.replyTo ? byId.get(m.replyTo.authorId) : null;
  const isMine = m.authorId === me.id;
  const canDelete = isMine || isAdmin;

  return (
    <div id={`msg-${m.id}`} className={`msg${grouped ? " grouped" : ""}${mentionedMe ? " mentioned" : ""}${p.pickerOpen ? " raised" : ""}`}>
      {m.replyTo && (
        <button className="reply-ref" onClick={() => p.onJumpTo(m.replyTo!.id)} title="Jump to the original message">
          <span className="reply-arrow">↪</span>
          <strong>{replyAuthor ? nameOfUser(replyAuthor) : m.replyTo.authorName}</strong>
          <span className="reply-snippet">{m.replyTo.snippet.replace(/\s+/g, " ") || (m.replyTo.hasExtra ? "Attachment" : "")}</span>
        </button>
      )}
      <div className="msg-main">
        {grouped ? (
          <span className="gutter" />
        ) : (
          <button className="avatar-btn" aria-label={`View ${authorName}'s profile`} onClick={() => p.onOpenProfile(m.authorId)}>
            <Avatar id={m.authorId} name={authorName} version={author ? author.avatarVersion : m.authorAvatar} accent={author?.accent} />
          </button>
        )}
        <div className="msg-body">
          {!grouped && (
            <div className="msg-meta">
              <button className="name" onClick={() => p.onOpenProfile(m.authorId)}>{authorName}</button>
              <time>{timeOf(m.createdAt)}</time>
            </div>
          )}
          {p.editing ? (
            <EditBox initial={m.content} onSave={p.onSaveEdit} onCancel={p.onCancelEdit} />
          ) : (
            m.content && (
              <p className="text">
                <RichText text={m.content} byName={byName} mentionIds={m.mentions} everyone={m.mentionsEveryone} meId={me.id} />
                {m.editedAt && <small className="edited" title={new Date(m.editedAt).toLocaleString()}> (edited)</small>}
              </p>
            )
          )}
          {m.gif && <img className="gif" src={m.gif} alt="GIF" loading="lazy" onLoad={p.onImageLoad} />}
          {m.attachments.length > 0 && (
            <div className="atts">
              {m.attachments.map((a) =>
                a.mime.startsWith("image/") ? (
                  <a key={a.id} href={`/api/files/${a.id}`} target="_blank" rel="noopener noreferrer" title={a.name}>
                    <img src={`/api/files/${a.id}`} alt={a.name} loading="lazy" onLoad={p.onImageLoad} />
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
          {m.poll && (
            <PollCard message={m} poll={m.poll} canClose={isMine || isAdmin} timedOut={timedOut} nameOf={p.nameOf} onVote={p.onVote} onClose={p.onClosePoll} />
          )}
          {m.reactions.length > 0 && (
            <div className="reactions">
              {m.reactions.map((r) => {
                const mine = r.userIds.includes(me.id);
                return (
                  <button key={r.emoji} className={mine ? "react mine" : "react"} aria-pressed={mine} disabled={timedOut} title={r.userIds.map(p.nameOf).join(", ")} onClick={() => p.onReact(r.emoji)}>
                    <Emoji emoji={r.emoji} /> <span>{r.userIds.length}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {!p.editing && (
        <div className={p.pickerOpen ? "msg-tools open" : "msg-tools"} onClick={(e) => e.stopPropagation()}>
          {!timedOut && (
            <>
              <button aria-label="Add reaction" aria-expanded={p.pickerOpen} onClick={p.onTogglePicker}>☺+</button>
              <button onClick={p.onReply}>Reply</button>
              {isMine && !m.poll && <button onClick={p.onStartEdit}>Edit</button>}
            </>
          )}
          {canDelete && <button className="danger" onClick={p.onDelete}>Delete</button>}
          {p.pickerOpen && <EmojiPicker className="down" onPick={p.onReact} />}
        </div>
      )}
    </div>
  );
}
