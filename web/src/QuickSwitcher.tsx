import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import type { Channel, DmSummary, ServerSummary } from "./types";
import { hue, nameOfUser } from "./util";

export type JumpTarget = { kind: "server" | "channel" | "dm"; serverId: string; channelId?: string };

interface Item {
  key: string;
  kind: JumpTarget["kind"];
  label: string;
  hint: string;
  unread: number;
  target: JumpTarget;
  icon: React.ReactNode;
  recent: number; // for ordering when nothing is typed
}

/** How well `q` matches `text`: higher is better, 0 means no match. Substrings beat scattered letters, and earlier beats later. */
function score(text: string, q: string) {
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 1000 - i * 5 - (t.length - q.length) + (i === 0 ? 200 : 0);
  let at = 0;
  for (const ch of q) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return 100 - (at - q.length);
}

/** Ctrl+K: jump to any server, channel or conversation by typing a few letters. */
export function QuickSwitcher({ servers, channels, activeServer, dms, unread, onJump, onClose }: {
  servers: ServerSummary[];
  channels: Channel[];
  activeServer: ServerSummary | null;
  dms: DmSummary[];
  unread: { channels: Record<string, number>; servers: Record<string, number> };
  onJump: (t: JumpTarget) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    dms.forEach((d, i) =>
      out.push({
        key: `dm:${d.id}`,
        kind: "dm",
        label: nameOfUser(d.user),
        hint: `@${d.user.username} · Message`,
        unread: unread.servers[d.id] ?? 0,
        target: { kind: "dm", serverId: d.id },
        icon: <Avatar id={d.user.id} name={nameOfUser(d.user)} version={d.user.avatarVersion} accent={d.user.accent} size={28} />,
        recent: 5000 - i,
      })
    );
    if (activeServer)
      channels.forEach((c, i) =>
        out.push({
          key: `ch:${c.id}`,
          kind: "channel",
          label: `# ${c.name}`,
          hint: activeServer.name,
          unread: unread.channels[c.id] ?? 0,
          target: { kind: "channel", serverId: activeServer.id, channelId: c.id },
          icon: <span className="qs-glyph">#</span>,
          recent: 3000 - i,
        })
      );
    servers.forEach((s, i) =>
      out.push({
        key: `sv:${s.id}`,
        kind: "server",
        label: s.name,
        hint: "Server",
        unread: unread.servers[s.id] ?? 0,
        target: { kind: "server", serverId: s.id },
        icon: <span className="qs-tile" style={{ background: `hsl(${hue(s.name)} 55% 45%)` }}>{s.name.slice(0, 2).toUpperCase()}</span>,
        recent: 1000 - i,
      })
    );
    return out;
  }, [servers, channels, activeServer, dms, unread]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^[#@]/, "");
    if (!q) {
      // Nothing typed: what needs you first (unread), then the usual places.
      return [...items].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.recent - a.recent).slice(0, 9);
    }
    const onlyChannels = query.trim().startsWith("#");
    const onlyPeople = query.trim().startsWith("@");
    return items
      .filter((it) => (onlyChannels ? it.kind === "channel" : onlyPeople ? it.kind === "dm" : true))
      .map((it) => ({ it, s: Math.max(score(it.label.replace(/^# /, ""), q), it.kind === "dm" ? score(it.hint, q) - 50 : 0) + (it.unread > 0 ? 30 : 0) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 9)
      .map((r) => r.it);
  }, [items, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [sel, results]);

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (results.length ? (s + 1) % results.length : 0)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (results.length ? (s - 1 + results.length) % results.length : 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[sel]; if (r) onJump(r.target); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  return (
    <div className="backdrop qs-backdrop" onMouseDown={onClose}>
      <div className="qs" role="dialog" aria-modal="true" aria-label="Quick switcher" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={key}
          placeholder="Jump to a channel, conversation or server…"
          role="combobox"
          aria-expanded="true"
          aria-controls="qs-list"
          aria-activedescendant={results[sel] ? `qs-${results[sel].key}` : undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="qs-list" id="qs-list" role="listbox" ref={list}>
          {results.length === 0 && <p className="muted qs-empty">Nothing matches “{query.trim()}”.</p>}
          {results.map((r, i) => (
            <button
              key={r.key}
              id={`qs-${r.key}`}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "qs-item on" : "qs-item"}
              onMouseMove={() => setSel(i)}
              onClick={() => onJump(r.target)}
              tabIndex={-1}
            >
              <span className="qs-icon">{r.icon}</span>
              <span className="qs-text"><b>{r.label}</b><small>{r.hint}</small></span>
              {r.unread > 0 && <span className="badge sm">{r.unread}</span>}
            </button>
          ))}
        </div>
        <footer className="qs-foot muted"><span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to open</span><span><kbd>Esc</kbd> to close</span><span>Start with <kbd>#</kbd> for channels or <kbd>@</kbd> for people</span></footer>
      </div>
    </div>
  );
}
