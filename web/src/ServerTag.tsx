import { useState } from "react";
import type { UserTag } from "./types";

/** Fired when someone clicks a tag that offers an invite. App.tsx listens and opens the server (if you're in it) or its invite. */
export const TAG_CLICK_EVENT = "huddle:server-tag-click";
export interface TagClickDetail { serverId: string; text: string }

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The little label some people wear next to their name: the tag of a verified or Huddle Official server they're in.
 * It can have its own color and a small picture, and clicking it opens an invite to its server (unless that is switched off).
 * `preview` shows the look without making it clickable (used in the server's tag settings).
 */
export function ServerTag({ tag, preview = false }: { tag?: UserTag | null; preview?: boolean }) {
  const [badIcon, setBadIcon] = useState(false);
  if (!tag) return null;
  const color = tag.color && HEX.test(tag.color) ? tag.color : null;
  const style = color ? { color, background: `color-mix(in srgb, ${color} 22%, transparent)` } : undefined;
  const hasIcon = !!tag.iconVersion && tag.iconVersion > 0 && !badIcon;
  const clickable = !!tag.invite && !preview;
  const className = ["stag", tag.official ? "official-tag" : "", clickable ? "clickable" : ""].filter(Boolean).join(" ");
  const open = () => window.dispatchEvent(new CustomEvent<TagClickDetail>(TAG_CLICK_EVENT, { detail: { serverId: tag.serverId, text: tag.text } }));
  const content = (
    <>
      {hasIcon ? (
        <img className="stag-icon" src={`/api/servers/${tag.serverId}/tag-icon?v=${tag.iconVersion}`} alt="" onError={() => setBadIcon(true)} />
      ) : tag.official ? (
        <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.3 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z" /></svg>
      ) : null}
      <span className="stag-text">{tag.text}</span>
    </>
  );
  const kind = `${tag.official ? "Huddle Official" : "Verified"} server tag`;
  if (!clickable) return <span className={className} style={style} title={kind}>{content}</span>;
  return (
    <span
      className={className}
      style={style}
      role="button"
      tabIndex={0}
      title={`${kind}. Click to see this server.`}
      onClick={(e) => { e.stopPropagation(); open(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); open(); } }}
    >
      {content}
    </span>
  );
}
