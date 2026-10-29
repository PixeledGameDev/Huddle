// A tiny stand-in for the Huddle page while the window is unloaded to save memory. It keeps one connection to the server so
// direct messages, @mentions and @everyone still pop up (and the tray dot still lights), then the page is rebuilt when you open Huddle.

/** Which kind of message is this for me? Returns "dm", "mention", "everyone", or null when it shouldn't notify at all. */
function classify(m, ctx) {
  if (!m || m.authorId === ctx.meId) return null;
  if (ctx.presence === "dnd") return null; // Do not disturb: nothing pops up
  const p = ctx.prefs;
  if (!p.enabled) return null;
  if (ctx.dmIds.has(m.serverId)) return p.dms ? "dm" : null;
  if (Array.isArray(m.mentions) && m.mentions.includes(ctx.meId)) return p.mentions ? "mention" : null;
  if (m.mentionsEveryone) return p.everyone ? "everyone" : null;
  return null;
}

/** A readable one-line version of a message: custom emoji become :name:, spoilers are hidden, spaces are tidied. */
function plain(text) {
  return String(text ?? "")
    .replace(/<a?:(\w+):[\w-]+>/g, ":$1:")
    .replace(/\|\|[^|]*\|\|/g, "[spoiler]")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the popup should say, matching what the page itself would have shown. */
function buildNote(m, kind, ctx) {
  const fallback = m.gif ? "Sent a GIF" : m.attachments?.length ? "Sent an attachment" : m.poll ? "Started a poll" : "New message";
  const text = plain(m.content) || fallback;
  const body = ctx.prefs.preview ? text.slice(0, 160) : kind === "dm" ? "Sent you a message" : "Mentioned you";
  const where = ctx.serverNames.get(m.serverId) ?? "a server";
  return {
    title: kind === "dm" ? m.authorName : `${m.authorName} in ${where}`,
    body,
    tag: m.channelId,
    target: { serverId: m.serverId, channelId: m.channelId },
  };
}

class Background {
  /**
   * origin: the Huddle server's address. session: Electron's session (it holds the sign-in cookie).
   * onNote(note, kind): show a popup. onUnread(count): the number of unread messages for you.
   */
  constructor({ origin, session, getPrefs, io, onNote, onUnread }) {
    this.origin = origin;
    this.session = session;
    this.getPrefs = getPrefs;
    this.io = io;
    this.onNote = onNote;
    this.onUnread = onUnread;
    this.socket = null;
    this.ctx = { meId: null, presence: "online", dmIds: new Set(), serverNames: new Map(), prefs: getPrefs() };
    this.unread = new Map(); // channelId -> how many
  }

  async get(path) {
    const r = await this.session.fetch(`${this.origin}${path}`, { credentials: "include" });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.json();
  }

  /** Connects. Resolves true once it's listening, false if it couldn't (signed out, offline) so the page should stay. */
  async start(timeoutMs = 8000) {
    try {
      const [me, dms, servers] = await Promise.all([this.get("/api/auth/me"), this.get("/api/dms"), this.get("/api/servers")]);
      this.ctx.meId = me.user.id;
      this.ctx.presence = me.user.presence ?? "online";
      this.ctx.dmIds = new Set(dms.dms.map((d) => d.id));
      this.ctx.serverNames = new Map(servers.servers.map((s) => [s.id, s.name]));
      const cookies = await this.session.cookies.get({ url: this.origin });
      const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return await new Promise((resolve) => {
        const s = this.io(this.origin, { transports: ["websocket"], extraHeaders: { cookie }, reconnection: true, reconnectionDelayMax: 30000 });
        this.socket = s;
        const timer = setTimeout(() => resolve(false), timeoutMs);
        s.once("connect", () => { clearTimeout(timer); resolve(true); });
        s.on("message.create", (m) => this.onMessage(m));
        s.on("dm.new", (d) => d?.id && this.ctx.dmIds.add(d.id));
        s.on("dm.hidden", () => {});
        s.on("presence.self", (p) => { this.ctx.presence = p?.presence ?? "online"; });
        s.on("server.removed", () => {});
        s.on("connect", () => { // after a reconnect, learn about servers and conversations joined meanwhile
          this.get("/api/servers").then((r) => { this.ctx.serverNames = new Map(r.servers.map((x) => [x.id, x.name])); }, () => {});
          this.get("/api/dms").then((r) => { this.ctx.dmIds = new Set(r.dms.map((d) => d.id)); }, () => {});
        });
      });
    } catch {
      this.stop();
      return false;
    }
  }

  onMessage(m) {
    this.ctx.prefs = this.getPrefs();
    const kind = classify(m, this.ctx);
    if (!kind) return;
    this.unread.set(m.channelId, (this.unread.get(m.channelId) ?? 0) + 1);
    this.onUnread(this.total());
    this.onNote(buildNote(m, kind, this.ctx), kind);
  }

  total() {
    let n = 0;
    for (const v of this.unread.values()) n += v;
    return n;
  }
  markRead(channelId) {
    this.unread.delete(channelId);
    this.onUnread(this.total());
  }

  stop() {
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
    this.unread.clear();
  }
}

module.exports = { Background, classify, buildNote, plain };
