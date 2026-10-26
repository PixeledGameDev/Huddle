import { SHORTCODE_NAMES, SHORTCODES } from "./emojiData";

/** Emoji whose :name: starts with the query come first (short, popular names lead), then ones that merely contain it. */
export function searchShortcodes(query: string, limit = 8): { name: string; glyph: string }[] {
  const q = query.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const name of SHORTCODE_NAMES) {
    if (name.startsWith(q)) {
      starts.push(name);
      if (starts.length >= limit) break;
    } else if (contains.length < limit && name.includes(q)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, limit).map((name) => ({ name, glyph: SHORTCODES.get(name)! }));
}
