/**
 * Global shortcuts: keys that work from any program, even while Huddle is hidden in the tray.
 *
 * Three actions can have one: show or hide Huddle, open the quick switcher, jump to the next unread message.
 * They are off until the person sets them, because any combination might already be used by something else.
 *
 * A shortcut works everywhere, so one with no modifier (a plain "A") would stop that key working in every program.
 * Only combinations with Ctrl, Alt or the Windows key are accepted. Registering is passed in, so this runs without Electron.
 */
const ACTIONS = ["toggle", "switcher", "unread"];

const MODIFIERS = {
  ctrl: "Control", control: "Control",
  alt: "Alt", option: "Alt",
  shift: "Shift",
  super: "Super", win: "Super", windows: "Super", meta: "Super", cmd: "Super", command: "Super",
};
const ORDER = ["Control", "Alt", "Shift", "Super"];
const NAMED = {
  space: "Space", tab: "Tab", backspace: "Backspace", delete: "Delete", del: "Delete", insert: "Insert", return: "Return", enter: "Return",
  home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", up: "Up", down: "Down", left: "Left", right: "Right", escape: "Escape", esc: "Escape",
};
const PUNCTUATION = new Set(["-", "=", "[", "]", ";", "'", ",", ".", "/", "\\", "`"]);
// The system keeps these for itself, so registering them fails or, worse, would be confusing.
const RESERVED = new Set(["Control+Alt+Delete", "Alt+F4", "Alt+Tab", "Control+Escape", "Alt+Escape", "Super+L", "Super+D", "Super+Tab"]);

function normalizeKey(token) {
  if (/^[a-z0-9]$/i.test(token)) return token.toUpperCase();
  const f = /^f([1-9]|1\d|2[0-4])$/i.exec(token);
  if (f) return `F${f[1]}`;
  const named = NAMED[token.toLowerCase()];
  if (named) return named;
  return PUNCTUATION.has(token) ? token : null;
}

/** "ctrl+shift+space" -> "Control+Shift+Space", or null if it isn't an acceptable shortcut. */
function normalizeAccelerator(text) {
  if (typeof text !== "string" || text.length > 60) return null;
  const tokens = text.split("+").map((t) => t.trim());
  if (tokens.some((t) => !t)) return null; // empty parts: "Ctrl++", "+A"
  const mods = new Set();
  let key = null;
  for (const t of tokens) {
    const m = MODIFIERS[t.toLowerCase()];
    if (m) {
      if (mods.has(m)) return null;
      mods.add(m);
    } else {
      if (key) return null; // two keys
      key = normalizeKey(t);
      if (!key) return null;
    }
  }
  if (!key || !(mods.has("Control") || mods.has("Alt") || mods.has("Super"))) return null;
  const out = [...ORDER.filter((m) => mods.has(m)), key].join("+");
  return RESERVED.has(out) ? null : out;
}

/**
 * Cleans what the page sent: { toggle, switcher, unread } with a shortcut or "" each.
 * `problems` says which ones were refused ("invalid", or "duplicate" when an earlier action already has that shortcut).
 */
function sanitizeHotkeys(raw) {
  const hotkeys = { toggle: "", switcher: "", unread: "" };
  const problems = {};
  const used = new Set();
  for (const action of ACTIONS) {
    const v = raw?.[action];
    if (v === undefined || v === null || v === "") continue;
    const accel = normalizeAccelerator(v);
    if (!accel) problems[action] = "invalid";
    else if (used.has(accel)) problems[action] = "duplicate";
    else {
      used.add(accel);
      hotkeys[action] = accel;
    }
  }
  return { hotkeys, problems };
}

/**
 * register(accelerator, callback) -> true if it worked (false when another program has it); unregister(accelerator).
 * run(action) does what the shortcut is for.
 */
function createHotkeyManager({ register, unregister, run }) {
  let active = [];
  function stop() {
    for (const accel of active) {
      try { unregister(accel); } catch { /* already gone */ }
    }
    active = [];
  }
  /** Replaces whatever was registered. status is "ok", "off" (not set), "taken" (another program has it), "invalid" or "duplicate". */
  function apply(raw) {
    stop();
    const { hotkeys, problems } = sanitizeHotkeys(raw);
    const status = {};
    for (const action of ACTIONS) {
      if (problems[action]) { status[action] = problems[action]; continue; }
      const accel = hotkeys[action];
      if (!accel) { status[action] = "off"; continue; }
      let ok = false;
      try { ok = !!register(accel, () => run(action)); } catch { ok = false; }
      if (ok) active.push(accel);
      status[action] = ok ? "ok" : "taken";
    }
    return { hotkeys, status };
  }
  return { apply, stop };
}

module.exports = { ACTIONS, normalizeAccelerator, sanitizeHotkeys, createHotkeyManager };
