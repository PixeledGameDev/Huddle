/**
 * Links that open Huddle (huddle://invite/CODE) and the commands the taskbar jump list sends (--open, --check-updates, --quit).
 *
 * Any web page can hand the app a huddle:// link, so this accepts only the exact shapes below and nothing else. An invite
 * link never joins anything by itself: it opens the same invite page as a normal link, where joining still needs a click.
 */
const INVITE_CODE = /^[A-Za-z0-9_-]{6,32}$/; // the same shape the server and the website use

/** "huddle://invite/CODE" -> { type: "invite", code }, "huddle://open" -> { type: "open" }, anything else -> null. */
function parseDeepLink(arg) {
  if (typeof arg !== "string" || arg.length > 200) return null;
  const raw = arg.trim();
  if (/[\u0000-\u0020\u007f\\]/.test(raw)) return null; // the URL parser would quietly drop line breaks and tabs; refuse them instead
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "huddle:" || u.username || u.password || u.port || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "open" && parts.length === 0) return { type: "open" };
  if (host === "invite" && parts.length === 1 && INVITE_CODE.test(parts[0])) return { type: "invite", code: parts[0] };
  return null;
}

/** What a launch (or a second launch while the app is running) asks for, from its command-line arguments. */
function parseLaunchArgs(argv) {
  const out = { deepLink: null, quit: false, checkUpdates: false, open: false };
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== "string") continue;
    if (a === "--quit") out.quit = true;
    else if (a === "--check-updates") out.checkUpdates = true;
    else if (a === "--open") out.open = true;
    else if (a.toLowerCase().startsWith("huddle:") && !out.deepLink) out.deepLink = parseDeepLink(a);
  }
  return out;
}

/** The page of the Huddle server to show for a link, or null. */
function invitePath(link) {
  return link?.type === "invite" ? `/invite/${link.code}` : null;
}

/** The entries for the Windows taskbar jump list (right-click the taskbar icon). */
function jumpListTasks(execPath) {
  const task = (title, description, args) => ({ program: execPath, arguments: args, iconPath: execPath, iconIndex: 0, title, description });
  return [
    task("Open Huddle", "Show the Huddle window", "--open"),
    task("Check for updates", "Look for a new version of Huddle", "--check-updates"),
    task("Quit Huddle", "Close Huddle completely, including its tray icon", "--quit"),
  ];
}

module.exports = { parseDeepLink, parseLaunchArgs, invitePath, jumpListTasks, INVITE_CODE };
