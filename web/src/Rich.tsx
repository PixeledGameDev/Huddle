import { useState, type ReactNode } from "react";
import { parse } from "@twemoji/parser";
import type { Member } from "./types";
import { nameOfUser } from "./util";

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

interface RichProps {
  text: string;
  byName: Map<string, Member>;
  mentionIds: string[];
  everyone: boolean;
  meId: string;
}

const MENTION = /(?<![\w@])@([A-Za-z0-9_]{3,20})(?!\w)/g;

/** Message text with Twemoji and @mention pills. Pills only render for people the server confirmed were mentioned. */
export function RichText({ text, byName, mentionIds, everyone, meId }: RichProps) {
  const entities = parse(text);
  const onlyEmoji = entities.length > 0 && entities.length <= 8 && text.replace(/\s/g, "") === entities.map((e) => e.text).join("");
  const nodes: ReactNode[] = [];
  let key = 0;

  const pushText = (s: string) => {
    let i = 0;
    for (const m of s.matchAll(MENTION)) {
      const at = m.index ?? 0;
      const name = m[1].toLowerCase();
      const member = byName.get(name);
      let pill: ReactNode = null;
      if (name === "everyone" && everyone) pill = <span key={key++} className="mention me">@everyone</span>;
      else if (member && mentionIds.includes(member.id)) pill = <span key={key++} className={member.id === meId ? "mention me" : "mention"}>@{nameOfUser(member)}</span>;
      if (!pill) continue;
      if (at > i) nodes.push(s.slice(i, at));
      nodes.push(pill);
      i = at + m[0].length;
    }
    if (i < s.length) nodes.push(s.slice(i));
  };

  let last = 0;
  for (const e of entities) {
    if (e.indices[0] > last) pushText(text.slice(last, e.indices[0]));
    nodes.push(<Emoji key={key++} emoji={e.text} big={onlyEmoji} />);
    last = e.indices[1];
  }
  if (last < text.length) pushText(text.slice(last));
  return <>{nodes}</>;
}
