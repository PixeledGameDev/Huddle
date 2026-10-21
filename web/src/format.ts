import { SHORTCODES } from "./emojiData";
import { INVITE_URL_RE, isOwnInviteUrl } from "./util";

/**
 * Message formatting: *italic*, **bold**, ***both***, and ||spoiler||. Formatting nests, and a backslash
 * escapes a marker (\*  \|  \:). Markers that don't pair up are left as plain text. Underscores are deliberately
 * not special, because usernames contain them.
 *
 * Two kinds of leaf are recognised here rather than later, so that nothing inside them is mistaken for formatting:
 * links (http:// and https://) and :emoji_shortcodes: that name a real emoji.
 */
export type FNode =
  | { t: "text"; v: string }
  | { t: "url"; v: string }
  | { t: "emoji"; v: string; name: string }
  | { t: "b" | "i" | "s"; c: FNode[] };

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

function runLength(src: string, at: number) {
  let n = 0;
  while (src[at + n] === "*") n++;
  return n;
}

/** Start index of the closing "||", or -1. */
function findSpoilerClose(src: string, from: number) {
  for (let j = from; j < src.length - 1; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (src[j] === "|" && src[j + 1] === "|") return j > from ? j : -1;
  }
  return -1;
}

/** Start index of the closing * or **, or -1. A closer must hug its text (no space before it). */
function findStarClose(src: string, from: number, len: 1 | 2) {
  for (let j = from; j < src.length; ) {
    if (src[j] === "\\") { j += 2; continue; }
    if (src[j] !== "*") { j++; continue; }
    const run = runLength(src, j);
    if (j > from && !isSpace(src[j - 1])) {
      if (len === 2 && run >= 2) return j + run - 2; // for ***x***, close with the last two stars
      if (len === 1 && run === 1) return j;
      if (len === 1 && run === 3) return j + 2; // *a **b*** : italic closes on the last star
    }
    j += run;
  }
  return -1;
}

const URL_START = /https?:\/\/[^\s<>\u0000-\u001f]+/iy;
const SHORTCODE = /:([A-Za-z0-9_+-]{1,64}):/y;
const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Cuts punctuation that belongs to the sentence (or to surrounding formatting), not to the link. */
function trimUrl(u: string): string {
  for (;;) {
    const last = u[u.length - 1];
    if (last !== undefined && ".,;:!?'\"*|~_\u2019\u201d\u00bb".includes(last)) u = u.slice(0, -1);
    else if (last === ")" && count(u, ")") > count(u, "(")) u = u.slice(0, -1);
    else if (last === "]" && count(u, "]") > count(u, "[")) u = u.slice(0, -1);
    else if (last === "}" && count(u, "}") > count(u, "{")) u = u.slice(0, -1);
    else return u;
  }
}

/** A link starting at src[at], or null. A link can't start in the middle of a word. */
function matchUrl(src: string, at: number): string | null {
  if (at > 0 && /[A-Za-z0-9]/.test(src[at - 1])) return null;
  URL_START.lastIndex = at;
  const m = URL_START.exec(src);
  if (!m) return null;
  const url = trimUrl(m[0]);
  return /^https?:\/\/[^\s/?#]/i.test(url) ? url : null;
}

export function parseFormat(src: string): FNode[] {
  const out: FNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) { out.push({ t: "text", v: buf }); buf = ""; }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && "*|\\:".includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (ch === "h" || ch === "H") {
      const url = matchUrl(src, i);
      if (url) {
        flush();
        out.push({ t: "url", v: url });
        i += url.length;
        continue;
      }
    }
    if (ch === ":") {
      SHORTCODE.lastIndex = i;
      const m = SHORTCODE.exec(src);
      const glyph = m && SHORTCODES.get(m[1].toLowerCase());
      if (m && glyph) {
        flush();
        out.push({ t: "emoji", v: glyph, name: m[1].toLowerCase() });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "|" && src[i + 1] === "|") {
      const end = findSpoilerClose(src, i + 2);
      if (end !== -1) {
        flush();
        out.push({ t: "s", c: parseFormat(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*") {
      const run = runLength(src, i);
      const len: 1 | 2 = run >= 2 ? 2 : 1;
      if (!isSpace(src[i + len])) {
        const close = findStarClose(src, i + len, len);
        if (close !== -1) {
          flush();
          out.push({ t: len === 2 ? "b" : "i", c: parseFormat(src.slice(i + len, close)) });
          i = close + len;
          continue;
        }
      }
      buf += "*".repeat(len); // couldn't pair up: literal
      i += len;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

/**
 * Plain text for previews (reply quotes). Spoilers are never shown, and a spoiler that was cut off by
 * truncation is treated as a spoiler through to the end rather than leaking its start.
 */
export function plainPreview(text: string): string {
  const closed = ((text.match(/\|\|/g) ?? []).length) % 2 === 1 ? `${text}||` : text;
  const flat = (nodes: FNode[]): string => nodes.map((n) => (n.t === "text" || n.t === "url" || n.t === "emoji" ? n.v : n.t === "s" ? "[spoiler]" : flat(n.c))).join("");
  return flat(parseFormat(closed)).replace(/\s+/g, " ").trim();
}

/** Is this one of this app's own invite links? Those get the server card instead of a link preview. */
function isInviteLink(url: string) {
  const m = new RegExp(INVITE_URL_RE).exec(url);
  return !!m && m[0] === url && isOwnInviteUrl(url);
}

/**
 * Links in a message that should get a preview card: in order, without repeats, at most 3. Links inside a spoiler
 * are skipped (a card would give the spoiler away), and so are this app's invite links (they have their own card).
 */
export function embedUrlsIn(text: string): string[] {
  const urls: string[] = [];
  const walk = (nodes: FNode[]) => {
    for (const n of nodes) {
      if (n.t === "url") { if (!isInviteLink(n.v) && !urls.includes(n.v)) urls.push(n.v); }
      else if (n.t === "b" || n.t === "i") walk(n.c);
    }
  };
  walk(parseFormat(text));
  return urls.slice(0, 3);
}
