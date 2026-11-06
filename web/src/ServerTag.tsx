import type { UserTag } from "./types";

/** The little label some people wear next to their name: the tag of a verified or Huddle Official server they're in. */
export function ServerTag({ tag }: { tag?: UserTag | null }) {
  if (!tag) return null;
  return (
    <span className={tag.official ? "stag official-tag" : "stag"} title={`${tag.official ? "Huddle Official" : "Verified"} server tag`}>
      {tag.official && (
        <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" /></svg>
      )}
      {tag.text}
    </span>
  );
}
