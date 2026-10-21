import { Fragment, useMemo, useState, type ReactNode } from "react";
import { parse } from "@twemoji/parser";
import { parseFormat, type FNode } from "./format";
import type { Member } from "./types";
import { INVITE_URL_RE, isOwnInviteUrl, nameOfUser } from "./util";

const fileCache = new Map<string, string | null>();
function twemojiFile(emoji: string): string | null {
  if (fileCache.has(emoji)) return fileCache.get(emoji)!;
  const url = parse(emoji)[0]?.url;
  const file = url ? url.split("/").pop()! : null;
  fileCache.set(emoji, file);
  return file;
}

/** Twemoji image, served by this app. Falls back to the native glyph for emoji newer than the bundled set. */
export function Emoji({ emoji, big }: { emoji: string; big?: boolean }) {
  const [bad, setBad] = useState(false);
  const file = twemojiFile(emoji);
  if (!file || bad) return <span className={big ? "emoji-native big" : "emoji-native"}>{emoji}</span>;
  return <img className={big ? "emoji big" : "emoji"} src={`/twemoji/${file}`} alt={emoji} draggable={false} loading="lazy" onError={() => setBad(true)} />;
}

/** Hidden until clicked (or activated with Enter/Space). Stays revealed afterwards. */
function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const reveal = () => setOpen(true);
  return (
    <span
      className={open ? "spoiler open" : "spoiler"}
      role={open ? undefined : "button"}
      tabIndex={open ? undefined : 0}
      aria-label={open ? undefined : "Spoiler. Activate to reveal."}
      onClick={open ? undefined : reveal}
      onKeyDown={open ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); reveal(); } }}
    >
      <span aria-hidden={!open}>{children}</span>
    </span>
  );
}

interface RichProps {
  text: string;
  byName: Map<string, Member>;
  mentionIds: string[];
  everyone: boolean;
  meId: string;
}

const MENTION = /(?<![\w@])@([A-Za-z0-9_]{3,20})(?!\w)/g;

/**
 * Message text: **bold**, *italic*, ||spoilers||, :shortcode: emoji, Twemoji, links, and @mention pills.
 * Pills only render for people the server confirmed were mentioned.
 */
export function RichText({ text, byName, mentionIds, everyone, meId }: RichProps) {
  const tree = useMemo(() => parseFormat(text), [text]);
  // A message that is nothing but emoji (typed, pasted, or :shortcodes:) shows them large.
  const onlyEmoji = useMemo(() => {
    if (!tree.every((n) => n.t === "text" || n.t === "emoji")) return false;
    const joined = tree.map((n) => (n.t === "text" || n.t === "emoji" ? n.v : "")).join("");
    const entities = parse(joined);
    return entities.length > 0 && entities.length <= 8 && joined.replace(/\s/g, "") === entities.map((e) => e.text).join("");
  }, [tree]);
  let key = 0;

  // Plain text: Twemoji and mention pills.
  const emojiAndMentions = (s: string): ReactNode[] => {
    const nodes: ReactNode[] = [];
    const pushText = (chunk: string) => {
      let i = 0;
      for (const m of chunk.matchAll(MENTION)) {
        const at = m.index ?? 0;
        const name = m[1].toLowerCase();
        const member = byName.get(name);
        let pill: ReactNode = null;
        if (name === "everyone" && everyone) pill = <span key={key++} className="mention me">@everyone</span>;
        else if (member && mentionIds.includes(member.id)) pill = <span key={key++} className={member.id === meId ? "mention me" : "mention"}>@{nameOfUser(member)}</span>;
        if (!pill) continue;
        if (at > i) nodes.push(chunk.slice(i, at));
        nodes.push(pill);
        i = at + m[0].length;
      }
      if (i < chunk.length) nodes.push(chunk.slice(i));
    };
    let last = 0;
    for (const e of parse(s)) {
      if (e.indices[0] > last) pushText(s.slice(last, e.indices[0]));
      nodes.push(<Emoji key={key++} emoji={e.text} big={onlyEmoji} />);
      last = e.indices[1];
    }
    if (last < s.length) pushText(s.slice(last));
    return nodes;
  };

  // Text leaf: Twemoji and mention pills.
  const leaf = (str: string): ReactNode[] => emojiAndMentions(str);

  // Links open in a new tab. This app's own invite links stay in the app, as before.
  const link = (url: string): ReactNode => {
    const m = new RegExp(INVITE_URL_RE).exec(url);
    if (m && m[0] === url && isOwnInviteUrl(url)) return <a key={key++} className="invite-link" href={url}>{url}</a>;
    return <a key={key++} className="msg-link" href={url} target="_blank" rel="noopener noreferrer nofollow ugc">{url}</a>;
  };

  const render = (nodes: FNode[]): ReactNode[] =>
    nodes.map((n) => {
      if (n.t === "text") return <Fragment key={key++}>{leaf(n.v)}</Fragment>;
      if (n.t === "url") return link(n.v);
      if (n.t === "emoji") return <Emoji key={key++} emoji={n.v} big={onlyEmoji} />;
      if (n.t === "b") return <strong key={key++}>{render(n.c)}</strong>;
      if (n.t === "i") return <em key={key++}>{render(n.c)}</em>;
      return <Spoiler key={key++}>{render(n.c)}</Spoiler>;
    });

  return <>{render(tree)}</>;
}
