import { plainPreview } from "./format";
import type { Message } from "./types";

/**
 * Notifications for messages that are meant for you: direct messages, @mentions, and @everyone.
 *
 * In a browser they use the Notification API (after you allow it); in the desktop app they go through the app, which
 * needs no permission and also sets the unread badge. Either way there's an optional chime, and a notification is
 * only shown while Huddle isn't the window you're looking at. They work while Huddle is open (a tab, or the desktop
 * app running in the tray), not when it's fully closed.
 */
export interface NotifyPrefs {
  enabled: boolean;
  sound: boolean;
  preview: boolean; // show what the message says (off: only who sent it)
  dms: boolean;
  mentions: boolean;
  everyone: boolean;
}
export type Target = { serverId: string; channelId: string };

const KEY = "huddle.notifications";
const DEFAULTS: NotifyPrefs = { enabled: true, sound: true, preview: true, dms: true, mentions: true, everyone: true };

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof NotifyPrefs)[]) if (typeof p[k] === "boolean") out[k] = p[k];
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}
export function saveNotifyPrefs(p: NotifyPrefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
  window.huddleDesktop?.syncNotifyPrefs?.(p); // the desktop app keeps a copy for when its page is unloaded to save memory
}

export type Permission = "granted" | "denied" | "default" | "unsupported";
export function permissionState(): Permission {
  if (window.huddleDesktop) return "granted";
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}
export async function requestPermission(): Promise<Permission> {
  if (window.huddleDesktop || typeof Notification === "undefined") return permissionState();
  try { await Notification.requestPermission(); } catch { /* old Safari uses a callback; state is read below */ }
  return permissionState();
}

// ---- chime (generated, so there's no sound file to load)
let audio: AudioContext | null = null;
let lastChime = 0;
export function playChime() {
  const now = Date.now();
  if (now - lastChime < 1500) return; // a burst of messages is one chime
  lastChime = now;
  try {
    audio ??= new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    void audio.resume();
    const t = audio.currentTime;
    [[880, 0], [1318.5, 0.11]].forEach(([freq, at]) => {
      const osc = audio!.createOscillator();
      const gain = audio!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t + at);
      gain.gain.exponentialRampToValueAtTime(0.16, t + at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.28);
      osc.connect(gain).connect(audio!.destination);
      osc.start(t + at);
      osc.stop(t + at + 0.3);
    });
  } catch { /* no audio available */ }
}

type Show = { title: string; body: string; tag: string; target?: Target };
let onOpen: (t: Target) => void = () => {};
let unsubscribeDesktop: (() => void) | null = null;

/** Called once by the app: says what to do when a notification is clicked. */
export function setNotificationOpener(fn: (t: Target) => void) {
  onOpen = fn;
  unsubscribeDesktop?.();
  unsubscribeDesktop = window.huddleDesktop?.onNotificationClick((t) => t && onOpen(t)) ?? null;
  window.huddleDesktop?.syncNotifyPrefs?.(loadNotifyPrefs());
  window.huddleDesktop?.pageReady?.(); // a popup clicked while the page was unloaded is waiting to be opened
}

/** Called once by the app: what to do when someone replies to, or marks read, a desktop notification popup. */
let unsubReply: (() => void) | null = null;
let unsubRead: (() => void) | null = null;
export function setNotificationActions(a: { reply: (t: Target, text: string) => Promise<void>; markRead: (t: Target) => void }) {
  const d = window.huddleDesktop;
  unsubReply?.();
  unsubRead?.();
  unsubReply = d?.onNotificationReply?.(async ({ id, target, text }) => {
    try {
      await a.reply(target, text);
      d.replyResult?.(id, true);
    } catch (err) {
      d.replyResult?.(id, false, err instanceof Error ? err.message : "Couldn't send.");
    }
  }) ?? null;
  unsubRead = d?.onNotificationMarkRead?.((t) => a.markRead(t)) ?? null;
}

function show(n: Show) {
  if (window.huddleDesktop) return window.huddleDesktop.notify(n);
  if (permissionState() !== "granted") return;
  try {
    const note = new Notification(n.title, { body: n.body, tag: n.tag, icon: "/icon.png", silent: true });
    note.onclick = () => {
      window.focus();
      if (n.target) onOpen(n.target);
      note.close();
    };
  } catch { /* some mobile browsers only allow service-worker notifications */ }
}

export type Kind = "dm" | "mention" | "everyone";

/** Decides whether this message should make a sound and/or a system notification, and does it. */
export function notifyIncoming(m: Message, kind: Kind, where: { serverName: string }) {
  const p = loadNotifyPrefs();
  if (!p.enabled || !(kind === "dm" ? p.dms : kind === "mention" ? p.mentions : p.everyone)) return;
  if (p.sound) playChime();
  if (document.hasFocus()) return; // you're looking at Huddle; the in-app badge and toast are enough

  const text = plainPreview(m.content) || (m.gif ? "Sent a GIF" : m.attachments.length ? "Sent an attachment" : m.poll ? "Started a poll" : "New message");
  const body = p.preview ? text.slice(0, 160) : kind === "dm" ? "Sent you a message" : "Mentioned you";
  const title = kind === "dm" ? m.authorName : `${m.authorName} in ${where.serverName}`;
  show({ title, body, tag: m.channelId, target: { serverId: m.serverId, channelId: m.channelId } });
}

export function sendTestNotification() {
  playChime();
  show({ title: "Huddle", body: "Notifications are working.", tag: "huddle-test" });
}

// ---- unread badge for the desktop app (taskbar / dock / tray)
export function updateBadge(count: number) {
  const d = window.huddleDesktop;
  if (!d) return;
  let icon: string | null = null;
  if (count > 0) {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      g.fillStyle = "#d93025";
      g.beginPath();
      g.arc(32, 32, 30, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.font = "bold 38px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(count > 9 ? "9+" : String(count), 32, 35);
      icon = c.toDataURL("image/png");
    }
  }
  d.setBadge(Math.min(count, 9999), icon);
}
