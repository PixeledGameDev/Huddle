import sprite from "./icons.svg?raw";

/**
 * Huddle's icons: one sheet of drawn icons (icons.svg, 24x24, 2px round strokes) used instead of emoji and symbol characters,
 * so they look the same on every device and take the color and size of the text around them.
 *
 *   <Icon name="close" />
 *
 * To add one: draw it in icons.svg as a <symbol id="i-NAME">, then add NAME to the list below.
 */
export const ICON_NAMES = [
  "close",
  "menu",
  "check",
  "plus",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "chevron-up",
  "chevron-down",
  "reply",
  "home",
  "zap",
  "message",
  "users",
  "user",
  "lock",
  "key",
  "bell",
  "monitor",
  "palette",
  "settings",
  "edit",
  "paperclip",
  "poll",
  "sticker",
  "smile",
  "smile-plus",
  "shield",
  "vote",
  "sparkles",
  "trash",
  "search",
  "link",
  "copy",
  "download",
  "upload",
  "info",
  "alert",
  "eye",
  "external",
  "refresh",
  "pin",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** Put this once at the top of the page: it holds the drawings that every <Icon /> points at. */
export function IconSprite() {
  return <div aria-hidden="true" style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }} dangerouslySetInnerHTML={{ __html: sprite }} />;
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `ico ${className}` : "ico"} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <use href={`#i-${name}`} />
    </svg>
  );
}
