/**
 * Choosing a global shortcut (desktop app): turns a key press into the text the desktop app wants, like "Control+Shift+Space".
 * The desktop app has the final say on what is acceptable (desktop-rs/src/hotkeys.rs); this only builds the text and gives early feedback.
 */
export type HotkeyAction = "toggle" | "switcher" | "unread";
export type HotkeyStatus = "ok" | "off" | "taken" | "invalid" | "duplicate";
export interface DesktopHotkeys {
  supported: boolean;
  hotkeys: Record<HotkeyAction, string>;
  status: Record<HotkeyAction, HotkeyStatus>;
}

const NAMED: Record<string, string> = {
  Space: "Space", Enter: "Return", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Backquote: "`",
};

export type Captured =
  | { accelerator: string }
  | { problem: "waiting" | "cancel" | "clear" | "needs-modifier" | "unsupported" };

type KeyInfo = Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">;

/** What a key press means while choosing a shortcut. Escape cancels, Backspace/Delete clears, a modifier alone keeps waiting. */
export function acceleratorFromEvent(e: KeyInfo): Captured {
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)$/.test(e.code)) return { problem: "waiting" };
  const anyModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  if (e.code === "Escape" && !anyModifier) return { problem: "cancel" };
  if ((e.code === "Backspace" || e.code === "Delete") && !anyModifier) return { problem: "clear" };
  let key: string | undefined = NAMED[e.code];
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^Digit(\d)$/.exec(e.code);
  const fn = /^F(\d{1,2})$/.exec(e.code);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  else if (fn && +fn[1] >= 1 && +fn[1] <= 24) key = `F${fn[1]}`;
  if (!key) return { problem: "unsupported" };
  if (!(e.ctrlKey || e.altKey || e.metaKey)) return { problem: "needs-modifier" }; // Shift alone would take over a normal key
  const parts = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super", key].filter(Boolean) as string[];
  return { accelerator: parts.join("+") };
}

/** "Control+Shift+Space" -> "Ctrl + Shift + Space", the way it's said out loud. */
export function formatAccelerator(accelerator: string): string {
  return accelerator.split("+").map((p) => (p === "Control" ? "Ctrl" : p === "Super" ? "Win" : p === "Return" ? "Enter" : p)).join(" + ");
}
