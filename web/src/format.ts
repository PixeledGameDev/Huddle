/**
 * Message formatting: *italic*, **bold**, ***both***, and ||spoiler||. Formatting nests, and a backslash
 * escapes a marker (\*  \|). Markers that don't pair up are left as plain text. Underscores are deliberately
 * not special, because usernames contain them.
 */
export type FNode = { t: "text"; v: string } | { t: "b" | "i" | "s"; c: FNode[] };

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

export function parseFormat(src: string): FNode[] {
  const out: FNode[] = [];
  let buf = "";
  const flush = () => {
    if (buf) { out.push({ t: "text", v: buf }); buf = ""; }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && "*|\\".includes(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
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
  const flat = (nodes: FNode[]): string => nodes.map((n) => (n.t === "text" ? n.v : n.t === "s" ? "[spoiler]" : flat(n.c))).join("");
  return flat(parseFormat(closed)).replace(/\s+/g, " ").trim();
}
