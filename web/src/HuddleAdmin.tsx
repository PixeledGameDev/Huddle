import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "./Dialogs";
import { api } from "./api";
import { Modal } from "./Modals";
import { fmtCountdown, pokeMaintenance, useMaintenance, useRemaining } from "./Maintenance";
import { ServerBadge } from "./Verified";

interface Overview {
  admins: { id: string; username: string; displayName: string | null; locked: boolean }[];
  servers: { id: string; name: string; verified: boolean; official: boolean; members: number; channels: { id: string; name: string }[] }[];
  people: number;
  broadcasting: boolean;
  bans: { id: string; username: string; reason: string | null; permanent: boolean; until: string | null }[];
}

const dur = (s?: number | null) => (s ? ` for ${s >= 86400 ? `${Math.round(s / 86400)} day(s)` : `${Math.round(s / 3600)} hour(s)`}` : " permanently");
function adminAuditText(e: { action: string; detail: any; actor: string | null }) {
  const who = `@${e.actor ?? "someone"}`;
  const d = e.detail ?? {};
  switch (e.action) {
    case "send.server": return `${who} sent a message as Huddle to a server`;
    case "broadcast.dms": return `${who} started a broadcast to ${d.recipients} people`;
    case "broadcast.dms.done": return `Broadcast finished: ${d.sent} sent, ${d.skipped} skipped, ${d.failed} failed`;
    case "grant": return `${who} gave Huddle Admin to @${d.username}`;
    case "revoke": return `${who} removed Huddle Admin from @${d.username}`;
    case "ban": return `${who} banned @${d.username}${dur(d.durationSeconds)}${d.reason ? ` (${d.reason})` : ""}`;
    case "unban": return `${who} unbanned @${d.username}`;
    case "delete.account": return `${who} deleted the account @${d.username}${d.deleteMessages ? " and their messages" : ""}${d.deletedServers?.length ? `, plus servers: ${d.deletedServers.join(", ")}` : ""}`;
    case "reset-code": return `${who} created a password reset code for @${d.username}`;
    case "disable-2fa": return `${who} turned off two-factor for @${d.username}`;
    case "maintenance.start": return `${who} turned on maintenance for ${d.minutes} minutes`;
    case "maintenance.change": return `${who} changed the maintenance timer to ${d.minutes} minutes from then`;
    case "maintenance.end": return `${who} ended maintenance`;
    case "server.verify": return `${who} verified ${d.name}`;
    case "server.unverify": return `${who} removed verification from ${d.name}`;
    case "autojoin.add": return `${who} made ${d.name} an auto-join server (${d.added} people added)`;
    case "autojoin.remove": return `${who} stopped auto-joining people to ${d.name}`;
    case "welcome.add": return `${who} added a welcome message (sending to ${d.recipients} people)`;
    case "welcome.add.done": return `Welcome message finished: ${d.sent} sent, ${d.skipped} skipped, ${d.failed} failed`;
    case "welcome.remove": return `${who} removed a welcome message`;
    case "server.official": return `${who} made ${d.name} Huddle Official`;
    case "server.unofficial": return `${who} removed Huddle Official from ${d.name}`;
    case "bot.script.add": return `${who} uploaded ${d.filename} to the bot @${d.bot}`;
    case "bot.script.remove": return `${who} removed ${d.filename} from the bot @${d.bot}`;
    case "bot.game.set": return `${who} gave the bot @${d.bot} the game ${d.title}`;
    case "bot.game.remove": return `${who} removed the game from the bot @${d.bot}`;
    case "bot.create": return `${who} made the bot @${d.bot} for the game ${d.game}`;
    default: return `${who}: ${e.action}`;
  }
}

const MAINT_LENGTHS: [string, string][] = [["5", "5 minutes"], ["15", "15 minutes"], ["30", "30 minutes"], ["60", "1 hour"], ["120", "2 hours"], ["360", "6 hours"], ["720", "12 hours"], ["1440", "1 day"], ["custom", "Custom…"]];

/** Servers everyone is added to: all existing accounts right away, and every new account when they register. */
function AutoJoinSection({ people, servers, onNotice, onError, onChanged }: { people: number; servers: { id: string; name: string; members: number }[]; onNotice: (t: string) => void; onError: (e: unknown) => void; onChanged: () => void }) {
  const [items, setItems] = useState<{ id: string; name: string; members: number }[]>([]);
  const [max, setMax] = useState(5);
  const [serverId, setServerId] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ servers: typeof items; max: number }>("/huddle/autojoin").then((r) => { setItems(r.servers); setMax(r.max); }, onError);
  }, [onError]);
  useEffect(load, [load]);
  const choices = servers.filter((s) => !items.some((i) => i.id === s.id));
  useEffect(() => { if (!choices.some((c) => c.id === serverId)) setServerId(choices[0]?.id ?? ""); }, [items, servers]); // eslint-disable-line react-hooks/exhaustive-deps

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const server = choices.find((c) => c.id === serverId);
    if (!server || busy) return;
    if (!await confirmDialog(`Add everyone (${people} ${people === 1 ? "person" : "people"}) to ${server.name} now, and everyone who makes an account from now on? People can leave afterwards.`, { confirmLabel: "Add everyone", danger: false })) return;
    setBusy(true);
    try {
      const r = await api<{ added: number }>("/huddle/autojoin", "POST", { serverId });
      onNotice(`${r.added} ${r.added === 1 ? "person was" : "people were"} added to ${server.name}.`);
      load();
      onChanged();
    } catch (err) { onError(err); }
    setBusy(false);
  }
  async function remove(id: string, name: string) {
    if (!await confirmDialog(`Stop adding new accounts to ${name}? Nobody is removed from it.`, { confirmLabel: "Stop" })) return;
    try {
      await api(`/huddle/autojoin/${id}`, "DELETE");
      load();
      onChanged();
    } catch (err) { onError(err); }
  }

  return (
    <form className="stack" onSubmit={add}>
      <h3>Servers everyone joins</h3>
      <small className="hint">Pick a server to add everyone to. All existing accounts are added right away, and so is every new account when they make one. People who are banned from that server are skipped, and anyone can leave afterwards.</small>
      {items.length > 0 && (
        <ul className="plain-list welcome-list">
          {items.map((s) => (
            <li key={s.id}>
              <span className="welcome-text">{s.name} <small className="hint">{s.members} {s.members === 1 ? "member" : "members"}</small></span>
              <button type="button" className="icon" onClick={() => void remove(s.id, s.name)}>Stop</button>
            </li>
          ))}
        </ul>
      )}
      <label>
        Server
        <select value={serverId} onChange={(e) => setServerId(e.target.value)} disabled={choices.length === 0 || items.length >= max}>
          {choices.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.members})</option>)}
        </select>
      </label>
      <button className="primary" disabled={busy || !serverId || items.length >= max}>{busy ? "Adding…" : items.length >= max ? `Limit of ${max} reached` : "Add everyone to this server"}</button>
    </form>
  );
}

interface HostedBot {
  id: string;
  username: string;
  displayName: string | null;
  owner: string;
  public: boolean;
  online: boolean;
  game: { title: string } | null;
  scripts: { filename: string; size: number; updatedAt: string; status: string; restarts: number; startedAt: string | null }[];
}
interface BotHosting {
  hosting: { enabled: boolean; pythonVersion: string | null };
  limits: { scripts: number; scriptKb: number; gameKb: number };
  builtinGames: { slug: string; title: string }[];
  bots: HostedBot[];
}

const STATUS_TEXT: Record<string, string> = {
  starting: "Starting", running: "Running", finished: "Finished", crashed: "Crashed, restarting", failed: "Stopped after crashing", stopped: "Not running",
};

/** Python scripts that run for a bot whenever Huddle starts, and games a bot can play in chat. */
function BotHostSection({ onNotice, onError, onChanged }: { onNotice: (t: string) => void; onError: (e: unknown) => void; onChanged: () => void }) {
  const [info, setInfo] = useState<BotHosting | null>(null);
  const [botId, setBotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [logFile, setLogFile] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [slug, setSlug] = useState("");
  const [newName, setNewName] = useState("");
  const [gameChoice, setGameChoice] = useState("");
  const [customTitle, setCustomTitle] = useState("");

  const load = useCallback(() => {
    api<BotHosting>("/huddle/bots").then((r) => {
      setInfo(r);
      setBotId((cur) => (r.bots.some((b) => b.id === cur) ? cur : r.bots[0]?.id ?? ""));
      setSlug((cur) => cur || r.builtinGames[0]?.slug || "");
      setGameChoice((cur) => cur || r.builtinGames[0]?.slug || "");
    }, onError);
  }, [onError]);
  useEffect(load, [load]);

  const bot = info?.bots.find((b) => b.id === botId) ?? null;
  const loadLogs = useCallback((file: string) => {
    if (!botId) return;
    api<{ lines: string[] }>(`/huddle/bots/${botId}/logs?file=${encodeURIComponent(file)}`).then((r) => setLogLines(r.lines), onError);
  }, [botId, onError]);
  useEffect(() => { setLogFile(null); setLogLines([]); }, [botId]);
  useEffect(() => {
    if (!logFile) return;
    loadLogs(logFile);
    const t = setInterval(() => loadLogs(logFile), 3000);
    return () => clearInterval(t);
  }, [logFile, loadLogs]);

  async function run(work: () => Promise<unknown>, done?: string) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      if (done) onNotice(done);
      load();
      onChanged();
    } catch (err) { onError(err); }
    setBusy(false);
  }

  const createFromGame = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ botId: string }>("/huddle/bots/from-game", "POST", { slug, username: newName.trim() });
      setNewName("");
      setBotId(r.botId);
    }, "Bot made. Anyone who manages a server can add it from server settings → Bots, and run /play.");
  };

  const uploadScripts = (files: FileList | null) => {
    if (!files?.length || !bot) return;
    const list = [...files];
    void run(async () => {
      for (const f of list) await api(`/huddle/bots/${bot.id}/scripts`, "PUT", { filename: f.name, content: await f.text() });
    }, `${list.length === 1 ? list[0].name : `${list.length} files`} uploaded. The bot's scripts were restarted.`);
  };

  const removeScript = async (file: string) => {
    if (!bot || !await confirmDialog(`Remove ${file} from @${bot.username}? Its scripts restart without it.`, { confirmLabel: "Remove" })) return;
    void run(() => api(`/huddle/bots/${bot.id}/scripts/${encodeURIComponent(file)}`, "DELETE"));
  };

  const setGame = () => bot && void run(() => api(`/huddle/bots/${bot.id}/game`, "PUT", { builtin: gameChoice }), "Game attached. People can run /play with this bot.");
  const uploadGame = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f || !bot) return;
    const html = await f.text();
    void run(() => api(`/huddle/bots/${bot.id}/game`, "PUT", { title: customTitle.trim() || f.name.replace(/\.html?$/i, ""), html }), "Game uploaded. People can run /play with this bot.");
  };
  const removeGame = async () => {
    if (!bot || !await confirmDialog(`Take the game away from @${bot.username}? /play stops working. Messages that already show it stop showing it too.`, { confirmLabel: "Remove game" })) return;
    void run(() => api(`/huddle/bots/${bot.id}/game`, "DELETE"));
  };

  if (!info) return <div className="stack"><h3>Bot scripts and games</h3><small className="hint">Loading…</small></div>;
  const pythonNote = !info.hosting.enabled
    ? "Running scripts is turned off on this server (BOT_HOST_DISABLED is true). Uploaded files are kept and will run once it's turned on."
    : info.hosting.pythonVersion
      ? `Python ${info.hosting.pythonVersion} is available.`
      : "Python 3 wasn't found on this server, so scripts can't run here.";

  return (
    <div className="stack">
      <h3>Bot scripts and games</h3>
      <small className="hint">
        Upload Python files to a bot and Huddle runs them whenever it starts (after every deploy or restart on Render), and again when you change them. Each script signs in as its bot: it gets the address in <code>HUDDLE_URL</code> and the bot's token in <code>HUDDLE_BOT_TOKEN</code>. A <code>requirements.txt</code> installs packages first.
        Scripts run with this server's permissions, so only give Huddle Admin to people you trust. {pythonNote}
      </small>

      {info.builtinGames.length > 0 && (
        <form className="stack" onSubmit={createFromGame}>
          <label>
            Make a public bot from a game that comes with Huddle
            <select value={slug} onChange={(e) => setSlug(e.target.value)}>
              {info.builtinGames.map((g) => <option key={g.slug} value={g.slug}>{g.title}</option>)}
            </select>
          </label>
          <div className="row">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Bot name, like DeepAnswer" maxLength={20} required aria-label="Bot name" />
            <button className="primary" disabled={busy || !newName.trim()}>Make bot</button>
          </div>
        </form>
      )}

      {info.bots.length === 0 ? (
        <small className="hint">No bots yet. Make one above, or make one in Account settings → Bots.</small>
      ) : (
        <>
          <label>
            Bot
            <select value={botId} onChange={(e) => setBotId(e.target.value)}>
              {info.bots.map((b) => <option key={b.id} value={b.id}>@{b.username} (made by @{b.owner}){b.online ? " · online" : ""}</option>)}
            </select>
          </label>

          {bot && (
            <>
              <h4>Game</h4>
              {bot.game ? (
                <div className="row">
                  <span className="grow">{bot.game.title} <small className="hint">People run /play to start it.</small></span>
                  <button type="button" className="icon" disabled={busy} onClick={() => void removeGame()}>Remove</button>
                </div>
              ) : <small className="hint">No game yet.</small>}
              {info.builtinGames.length > 0 && (
                <div className="row">
                  <select value={gameChoice} onChange={(e) => setGameChoice(e.target.value)} aria-label="Game that comes with Huddle">
                    {info.builtinGames.map((g) => <option key={g.slug} value={g.slug}>{g.title}</option>)}
                  </select>
                  <button type="button" className="primary" disabled={busy || !gameChoice} onClick={setGame}>{bot.game ? "Replace with this game" : "Use this game"}</button>
                </div>
              )}
              <label>
                Or upload your own game: one .html file, up to {info.limits.gameKb} KB, that works without the internet
                <input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} placeholder="Game name (optional)" maxLength={60} />
                <input type="file" accept=".html,.htm,text/html" disabled={busy} onChange={(e) => { void uploadGame(e.target.files); e.target.value = ""; }} />
              </label>

              <h4>Python scripts</h4>
              {bot.scripts.length === 0 ? <small className="hint">No files yet.</small> : (
                <ul className="plain-list welcome-list">
                  {bot.scripts.map((s) => (
                    <li key={s.filename}>
                      <span className="welcome-text">{s.filename} <small className="hint">{STATUS_TEXT[s.status] ?? s.status}{s.restarts ? `, restarted ${s.restarts}×` : ""} · {Math.max(1, Math.round(s.size / 1000))} KB</small></span>
                      <button type="button" className="icon" onClick={() => setLogFile(logFile === s.filename ? null : s.filename)}>{logFile === s.filename ? "Hide log" : "Log"}</button>
                      <button type="button" className="icon" disabled={busy} onClick={() => void removeScript(s.filename)}>Remove</button>
                    </li>
                  ))}
                </ul>
              )}
              {logFile && <pre className="bot-log" aria-label={`Log of ${logFile}`}>{logLines.length ? logLines.join("\n") : "Nothing printed yet."}</pre>}
              <label>
                Add .py files (up to {info.limits.scripts} files, {info.limits.scriptKb} KB each)
                <input type="file" accept=".py,.txt,text/x-python,text/plain" multiple disabled={busy} onChange={(e) => { uploadScripts(e.target.files); e.target.value = ""; }} />
              </label>
              {bot.scripts.length > 0 && <button type="button" className="link left" disabled={busy} onClick={() => void run(() => api(`/huddle/bots/${bot.id}/restart`, "POST"), "Restarting this bot's scripts.")}>Restart this bot's scripts</button>}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Messages the Huddle bot sends to every new account (and, when one is added, to everyone who already has an account). */
function WelcomeSection({ people, broadcasting, onNotice, onError, onChanged }: { people: number; broadcasting: boolean; onNotice: (t: string) => void; onError: (e: unknown) => void; onChanged: () => void }) {
  const [items, setItems] = useState<{ id: string; content: string; createdAt: string; sent: number }[]>([]);
  const [max, setMax] = useState(10);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api<{ messages: typeof items; max: number }>("/huddle/welcome").then((r) => { setItems(r.messages); setMax(r.max); }, onError);
  }, [onError]);
  useEffect(load, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !content.trim()) return;
    if (!await confirmDialog(`Add this welcome message? Everyone who has an account (${people} ${people === 1 ? "person" : "people"}) is sent it now as Huddle, and so is everyone who signs up from now on. This can't be unsent.`, { confirmLabel: "Add and send", danger: false })) return;
    setBusy(true);
    try {
      const r = await api<{ recipients: number }>("/huddle/welcome", "POST", { content });
      onNotice(`Welcome message added. Sending to ${r.recipients} people as Huddle…`);
      setContent("");
      load();
      onChanged();
    } catch (err) { onError(err); }
    setBusy(false);
  }
  async function remove(id: string) {
    if (!await confirmDialog("Remove this welcome message? New accounts won't get it any more. People who already received it keep it.", { confirmLabel: "Remove" })) return;
    try {
      await api(`/huddle/welcome/${id}`, "DELETE");
      load();
      onChanged();
    } catch (err) { onError(err); }
  }

  return (
    <form className="stack" onSubmit={add}>
      <h3>Welcome messages</h3>
      <small className="hint">Huddle sends these as a direct message to everyone who makes an account, oldest first. Adding one also sends it to everyone who already has an account. People who blocked Huddle don't get them.</small>
      {items.length > 0 && (
        <ol className="plain-list welcome-list">
          {items.map((m) => (
            <li key={m.id}>
              <span className="welcome-text">{m.content} <small className="hint">Sent to {m.sent}</small></span>
              <button type="button" className="icon" onClick={() => void remove(m.id)}>Remove</button>
            </li>
          ))}
        </ol>
      )}
      <label>
        New welcome message
        <textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} rows={4} placeholder="Welcome to Huddle! …" />
      </label>
      {broadcasting && <small className="hint">A message is still being delivered to everyone. Wait for it to finish before adding another.</small>}
      <button className="primary" disabled={busy || broadcasting || !content.trim() || items.length >= max}>
        {busy ? "Adding…" : items.length >= max ? `Limit of ${max} reached` : "Add welcome message"}
      </button>
    </form>
  );
}

/** Turns Huddle off for everyone but Huddle Admins, for a set time. */
function MaintenanceSection({ onNotice, onError, onChanged }: { onNotice: (t: string) => void; onError: (e: unknown) => void; onChanged: () => void }) {
  const { state, skew, refresh } = useMaintenance();
  const [length, setLength] = useState("30");
  const [custom, setCustom] = useState("45");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const left = useRemaining(state.active ? state.endsAt : null, skew, refresh);
  const minutes = length === "custom" ? Math.floor(Number(custom)) : Number(length);
  const valid = Number.isFinite(minutes) && minutes >= 1 && minutes <= 10080;
  const label = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} hour${minutes === 60 ? "" : "s"}` : `${minutes} minute${minutes === 1 ? "" : "s"}`;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    const ok = await confirmDialog(
      state.active
        ? `Change the timer? Maintenance will now end ${label} from now.`
        : `Start maintenance for ${label}? Everyone except Huddle Admins is signed out of the app and locked out until the timer ends.`,
      { confirmLabel: state.active ? "Change timer" : "Start maintenance", danger: !state.active }
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api("/huddle/maintenance", "POST", { minutes, message: message.trim() || undefined });
      onNotice(state.active ? `Maintenance now ends in ${label}.` : `Maintenance is on for ${label}.`);
      await refresh();
      pokeMaintenance();
      onChanged();
    } catch (err) { onError(err); } finally { setBusy(false); }
  }
  async function end() {
    if (!(await confirmDialog("End maintenance now? Everyone can use Huddle again right away.", { confirmLabel: "End maintenance", danger: false }))) return;
    setBusy(true);
    try {
      await api("/huddle/maintenance", "DELETE");
      onNotice("Maintenance ended.");
      await refresh();
      pokeMaintenance();
      onChanged();
    } catch (err) { onError(err); } finally { setBusy(false); }
  }

  return (
    <form className={`stack${state.active ? " maint-on" : ""}`} onSubmit={start}>
      <h3>Maintenance</h3>
      {state.active ? (
        <div className="maint-status">
          <span className="lp-live" aria-hidden="true" />
          <div>
            <b>Maintenance is on</b>
            <small className="hint">{fmtCountdown(left)} left · ends around {new Date(state.endsAt!).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small>
          </div>
          <button type="button" className="pill" disabled={busy} onClick={end}>End now</button>
        </div>
      ) : (
        <small className="hint">Turn Huddle off for everyone except Huddle Admins. They see a countdown, and the app and website come back by themselves when it hits zero.</small>
      )}
      <div className="row">
        <label>
          {state.active ? "Reset the timer to" : "How long"}
          <select value={length} onChange={(e) => setLength(e.target.value)}>{MAINT_LENGTHS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        {length === "custom" && (
          <label>
            Minutes
            <input type="number" min={1} max={10080} value={custom} onChange={(e) => setCustom(e.target.value)} required />
          </label>
        )}
      </div>
      <label>
        Note for people (optional)
        <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="e.g. Upgrading the database" />
      </label>
      <button className={state.active ? "pill" : "danger-fill"} disabled={busy || !valid}>{state.active ? "Change timer" : "Start maintenance"}</button>
    </form>
  );
}

const BAN_LENGTHS: [string, string][] = [["3600", "1 hour"], ["86400", "1 day"], ["604800", "1 week"], ["2592000", "30 days"], ["", "Permanent"]];

/** Only ever opened by Huddle Admins (the server answers everyone else with "not found"). */
export function HuddleAdminModal({ meId, onClose, onNotice, onError }: { meId: string; onClose: () => void; onNotice: (text: string) => void; onError: (e: unknown) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [target, setTarget] = useState<"dms" | "server">("server");
  const [serverId, setServerId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [username, setUsername] = useState("");
  const [who, setWho] = useState("");
  const [action, setAction] = useState<"ban" | "delete">("ban");
  const [banLength, setBanLength] = useState("86400");
  const [reason, setReason] = useState("");
  const [wipeMessages, setWipeMessages] = useState(true);
  const [wipeServers, setWipeServers] = useState(false);
  const [helpWho, setHelpWho] = useState("");
  const [issued, setIssued] = useState<{ username: string; code: string; minutes: number } | null>(null);

  const [audit, setAudit] = useState<{ id: number; action: string; detail: any; createdAt: string; actor: string | null }[]>([]);
  const [auditMore, setAuditMore] = useState(false);
  const loadAudit = useCallback((more: boolean, last?: number) => {
    api<{ entries: typeof audit; hasMore: boolean }>(`/huddle/audit${more && last ? `?before=${last}` : ""}`).then((r) => {
      setAudit((cur) => (more ? [...cur, ...r.entries] : r.entries));
      setAuditMore(r.hasMore);
    }, onError);
  }, [onError]);
  useEffect(() => loadAudit(false), [loadAudit]);

  async function setVerified(id: string, verified: boolean) {
    try {
      await api(`/huddle/servers/${id}/verified`, "POST", { verified });
      load();
      loadAudit(false);
    } catch (err) { onError(err); }
  }

  async function setOfficial(id: string, official: boolean) {
    try {
      await api(`/huddle/servers/${id}/official`, "POST", { official });
      load();
      loadAudit(false);
    } catch (err) { onError(err); }
  }

  const load = useCallback(() => {
    api<Overview>("/huddle/overview").then((o) => {
      setData(o);
      setServerId((cur) => cur || o.servers[0]?.id || "");
    }, onError);
  }, [onError]);
  useEffect(load, [load]);

  const server = data?.servers.find((s) => s.id === serverId);
  useEffect(() => setChannelId(server?.channels[0]?.id ?? ""), [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!data || sending) return;
    if (target === "dms" && !await confirmDialog(`Send this to everyone's direct messages (${data.people} people) as Huddle? This can't be undone.`)) return;
    setSending(true);
    try {
      if (target === "dms") {
        const r = await api<{ recipients: number }>("/huddle/send", "POST", { target, content });
        onNotice(`Sending to ${r.recipients} people as Huddle…`);
      } else {
        const r = await api<{ server: string; channel: string }>("/huddle/send", "POST", { target, serverId, channelId, content });
        onNotice(`Sent to #${r.channel} in ${r.server} as Huddle.`);
      }
      setContent("");
      load();
    } catch (err) {
      onError(err);
    } finally {
      setSending(false);
    }
  }

  async function grant(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ username: string }>("/huddle/admins", "POST", { username });
      onNotice(`${r.username} is now a Huddle Admin.`);
      setUsername("");
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function moderate(e: React.FormEvent) {
    e.preventDefault();
    const name = who.trim().replace(/^@/, "");
    try {
      if (action === "ban") {
        const length = banLength ? Number(banLength) : null;
        if (!await confirmDialog(`Ban @${name} from Huddle ${length ? `for ${BAN_LENGTHS.find(([v]) => v === banLength)![1]}` : "permanently"}? They'll be signed out right away.`)) return;
        await api("/huddle/users/ban", "POST", { username: name, durationSeconds: length, reason: reason.trim() || undefined });
        onNotice(`@${name} is banned.`);
      } else {
        if (!await confirmDialog(`Permanently delete @${name}'s account? This can't be undone.`)) return;
        const r = await api<{ deletedServers: number }>("/huddle/users/delete", "POST", { username: name, confirm: name, deleteMessages: wipeMessages, deleteOwnedServers: wipeServers });
        onNotice(`@${name}'s account was deleted${r.deletedServers ? ` along with ${r.deletedServers} server${r.deletedServers === 1 ? "" : "s"}` : ""}.`);
      }
      setWho("");
      setReason("");
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function makeResetCode() {
    try {
      setIssued(await api<{ username: string; code: string; minutes: number }>("/huddle/users/reset-code", "POST", { username: helpWho.trim().replace(/^@/, "") }));
    } catch (err) {
      setIssued(null);
      onError(err);
    }
  }
  async function turnOff2fa() {
    const name = helpWho.trim().replace(/^@/, "");
    if (!await confirmDialog(`Turn off two-factor sign-in for @${name}? Only do this once you're sure it's really them.`)) return;
    try {
      await api("/huddle/users/disable-2fa", "POST", { username: name });
      onNotice(`Two-factor is off for @${name}.`);
    } catch (err) {
      onError(err);
    }
  }

  async function unban(id: string, name: string) {
    try {
      await api(`/huddle/users/${id}/unban`, "POST");
      onNotice(`@${name} is unbanned.`);
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function revoke(id: string, name: string) {
    if (!await confirmDialog(`Remove Huddle Admin from ${name}?`)) return;
    try {
      await api(`/huddle/admins/${id}`, "DELETE");
      onNotice(`${name} is no longer a Huddle Admin.`);
      load();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <Modal title="Huddle Admin" onClose={onClose}>
      {!data ? (
        <p>Loading…</p>
      ) : (
        <>
          <MaintenanceSection onNotice={onNotice} onError={onError} onChanged={() => loadAudit(false)} />
          <hr />
          <form className="stack" onSubmit={send}>
            <h3>Send a message as Huddle</h3>
            <label>
              Send to
              <select value={target} onChange={(e) => setTarget(e.target.value as "dms" | "server")}>
                <option value="server">One server</option>
                <option value="dms">Everyone, in their direct messages</option>
              </select>
            </label>
            {target === "server" && (
              <div className="row">
                <label>
                  Server
                  <select value={serverId} onChange={(e) => setServerId(e.target.value)} required>
                    {data.servers.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.members})</option>)}
                  </select>
                </label>
                <label>
                  Channel
                  <select value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                    {server?.channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </select>
                </label>
              </div>
            )}
            <label>
              Message
              <textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} rows={5} required />
            </label>
            {target === "dms" && <small className="hint">Goes to {data.people} {data.people === 1 ? "person" : "people"}, except anyone who has blocked Huddle. People can't reply to it.</small>}
            {data.broadcasting && target === "dms" && <small className="hint">A broadcast is still being delivered. Wait for it to finish before sending another.</small>}
            <button className="primary" disabled={sending || !content.trim() || (target === "server" && !channelId) || (target === "dms" && data.broadcasting)}>
              {sending ? "Sending…" : "Send as Huddle"}
            </button>
          </form>
          <hr />
          <AutoJoinSection people={data.people} servers={data.servers} onNotice={onNotice} onError={onError} onChanged={() => { load(); loadAudit(false); }} />
          <hr />
          <WelcomeSection people={data.people} broadcasting={data.broadcasting} onNotice={onNotice} onError={onError} onChanged={() => { load(); loadAudit(false); }} />
          <hr />
          <form className="stack danger-zone" onSubmit={moderate}>
            <h3>Ban or delete a person</h3>
            <label>
              Username
              <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Username" maxLength={40} required autoComplete="off" />
            </label>
            <label>
              Action
              <select value={action} onChange={(e) => setAction(e.target.value as "ban" | "delete")}>
                <option value="ban">Ban from Huddle (signs them out)</option>
                <option value="delete">Delete their account completely</option>
              </select>
            </label>
            {action === "ban" ? (
              <div className="row">
                <label>
                  For
                  <select value={banLength} onChange={(e) => setBanLength(e.target.value)}>
                    {BAN_LENGTHS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
                  </select>
                </label>
                <label>
                  Reason (they'll see it when they try to sign in)
                  <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
                </label>
              </div>
            ) : (
              <>
                <label className="check"><input type="checkbox" checked={wipeMessages} onChange={(e) => setWipeMessages(e.target.checked)} /> Also delete all their messages, reactions and poll votes</label>
                <label className="check"><input type="checkbox" checked={wipeServers} onChange={(e) => setWipeServers(e.target.checked)} /> Also delete servers they own (otherwise this is refused if they own any)</label>
                <small className="hint">Their name, picture, bio and memberships are erased and the username frees up. Anything of theirs left in other people's conversations shows as "Deleted user". Other Huddle Admins can't be targeted.</small>
              </>
            )}
            <button className="danger-fill" disabled={!who.trim()}>{action === "ban" ? "Ban" : "Delete account"}</button>
          </form>
          <div className="stack">
            <h3>Help someone get back in</h3>
            <small className="hint">Huddle has no email, so this is how people reset a forgotten password: they ask you, you make a one-time code, and they enter it under "Forgot your password?". Check it's really them first, then give them the code by another route. Other Huddle Admins can't be targeted.</small>
            <label>
              Username
              <input value={helpWho} onChange={(e) => { setHelpWho(e.target.value); setIssued(null); }} placeholder="Username" maxLength={40} autoComplete="off" />
            </label>
            <div className="row">
              <button type="button" disabled={!helpWho.trim()} onClick={makeResetCode}>Create a reset code</button>
              <button type="button" disabled={!helpWho.trim()} onClick={turnOff2fa}>Turn off their two-factor</button>
            </div>
            {issued && (
              <div className="stack tight">
                <span>Reset code for @{issued.username} (shown once, works for {issued.minutes} minutes):</span>
                <div className="secret-key">{issued.code}</div>
                <small className="hint">They open Huddle → Forgot your password? → "I already have a code", enter their username, this code, and a new password. If they have two-factor on, they'll also need their authenticator or a recovery code; otherwise turn it off above.</small>
              </div>
            )}
          </div>
          <hr />
          <div className="stack">
            <h3>Verified and Official servers</h3>
            <small className="hint">Verified servers get a check mark next to their name everywhere. Huddle Official servers get a star badge instead, for servers Huddle itself runs. Nothing in a server's own activity log shows who set either.</small>
            <ul className="plain-list">
              {data.servers.map((s) => (
                <li key={s.id}>
                  <span>{s.name} <small className="hint">{s.members} {s.members === 1 ? "member" : "members"}</small><ServerBadge verified={s.verified} official={s.official} /></span>
                  <span className="row-actions">
                    <button type="button" className="icon" onClick={() => void setVerified(s.id, !s.verified)}>{s.verified ? "Remove verification" : "Verify"}</button>
                    <button type="button" className="icon" onClick={() => void setOfficial(s.id, !s.official)}>{s.official ? "Remove Official" : "Make Official"}</button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <hr />
          {data.bans.length > 0 && (
            <div className="stack">
              <h3>Banned</h3>
              <ul className="plain-list">
                {data.bans.map((b) => (
                  <li key={b.id}>
                    <span>@{b.username} <small className="hint">{b.permanent ? "Permanent" : `until ${new Date(b.until!).toLocaleString()}`}{b.reason ? ` · ${b.reason}` : ""}</small></span>
                    <button type="button" className="icon" onClick={() => unban(b.id, b.username)}>Unban</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <hr />
          <div className="stack">
            <h3>Huddle Admins</h3>
            <small className="hint">Huddle Admins are admins in every server and can use this panel. Nothing in the app shows who they are.</small>
            <ul className="plain-list">
              {data.admins.map((a) => (
                <li key={a.id}>
                  <span>{a.displayName ?? a.username} <small className="hint">@{a.username}{a.id === meId ? " (you)" : ""}</small></span>
                  {a.locked ? <small className="hint">Permanent</small> : <button type="button" className="icon" onClick={() => revoke(a.id, a.username)}>Remove</button>}
                </li>
              ))}
            </ul>
            <form className="row" onSubmit={grant}>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Username to give Huddle Admin" maxLength={40} required aria-label="Username" />
              <button className="primary">Give</button>
            </form>
          </div>
          <hr />
          <BotHostSection onNotice={onNotice} onError={onError} onChanged={() => loadAudit(false)} />
          <hr />
          <div className="stack">
            <h3>Audit log</h3>
            <small className="hint">Everything Huddle Admins have done, newest first.</small>
            <ul className="audit">
              {audit.length === 0 && <li className="hint">Nothing yet.</li>}
              {audit.map((e) => <li key={e.id}><time>{new Date(e.createdAt).toLocaleString()}</time>{adminAuditText(e)}</li>)}
            </ul>
            {auditMore && <button type="button" className="link center-btn" onClick={() => loadAudit(true, audit[audit.length - 1]?.id)}>Load older entries</button>}
          </div>
        </>
      )}
    </Modal>
  );
}
