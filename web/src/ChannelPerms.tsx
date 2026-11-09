import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { ChannelPerm, ServerDetail } from "./types";

const PERMS: { id: ChannelPerm; label: string; hint: string }[] = [
  { id: "view_channel", label: "View channel", hint: "See the channel and read what's in it. Without this, the rest doesn't matter." },
  { id: "send_messages", label: "Send messages", hint: "Write messages, replies and polls." },
  { id: "add_reactions", label: "Add reactions", hint: "React to messages with emoji." },
  { id: "attach_files", label: "Attach files", hint: "Upload images, videos and files." },
];
type Choice = "inherit" | "allow" | "deny";
type Row = Record<ChannelPerm, Choice>;
const blank = (): Row => ({ view_channel: "inherit", send_messages: "inherit", add_reactions: "inherit", attach_files: "inherit" });
const EVERYONE = "everyone";

/**
 * Per-channel permissions: for one channel, say what everyone (and each role) is allowed or denied.
 * "Inherit" means no opinion, so the channel stays open. A role that allows something beats another role's deny.
 */
export function ChannelPermsTab({ server, onError }: { server: ServerDetail; onError: (e: unknown) => void }) {
  const [channelId, setChannelId] = useState(server.channels[0]?.id ?? "");
  const [grid, setGrid] = useState<Record<string, Row> | null>(null);
  const [saved, setSaved] = useState<Record<string, Row> | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const roles = useMemo(() => [...server.roles].sort((a, b) => b.position - a.position), [server.roles]);
  const keys = useMemo(() => [EVERYONE, ...roles.map((r) => r.id)], [roles]);

  useEffect(() => {
    if (!channelId) return;
    setGrid(null);
    let live = true;
    api<{ overrides: { roleId: string | null; allow: ChannelPerm[]; deny: ChannelPerm[] }[] }>(`/servers/${server.id}/channels/${channelId}/permissions`).then((r) => {
      if (!live) return;
      const next: Record<string, Row> = Object.fromEntries(keys.map((k) => [k, blank()]));
      for (const o of r.overrides) {
        const row = next[o.roleId ?? EVERYONE];
        if (!row) continue;
        for (const p of o.allow) row[p] = "allow";
        for (const p of o.deny) row[p] = "deny";
      }
      setGrid(next);
      setSaved(JSON.parse(JSON.stringify(next)));
    }, onError);
    return () => { live = false; };
  }, [server.id, channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!grid && JSON.stringify(grid) !== JSON.stringify(saved);
  const set = (key: string, perm: ChannelPerm, value: Choice) => setGrid((g) => (g ? { ...g, [key]: { ...g[key], [perm]: value } } : g));

  async function save() {
    if (!grid || busy) return;
    setBusy(true);
    try {
      const overrides = keys
        .map((k) => ({
          roleId: k === EVERYONE ? null : k,
          allow: PERMS.filter((p) => grid[k][p.id] === "allow").map((p) => p.id),
          deny: PERMS.filter((p) => grid[k][p.id] === "deny").map((p) => p.id),
        }))
        .filter((o) => o.allow.length || o.deny.length);
      await api(`/servers/${server.id}/channels/${channelId}/permissions`, "PUT", { overrides });
      setSaved(JSON.parse(JSON.stringify(grid)));
      setFlash(true);
      window.setTimeout(() => setFlash(false), 2000);
    } catch (err) { onError(err); }
    setBusy(false);
  }

  const nameOf = (k: string) => (k === EVERYONE ? "Everyone" : roles.find((r) => r.id === k)?.name ?? "Role");

  return (
    <div className="stack">
      <small className="hint">Every channel starts open to everyone. Choose a channel, then allow or deny things for everyone or for particular roles. Owners and anyone who can manage channels always have full access, and a role that allows something beats another role's deny.</small>
      <label>Channel
        <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
          {server.channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </label>
      {!grid ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="perm-grid-wrap">
          <table className="perm-grid">
            <thead>
              <tr><th scope="col">Who</th>{PERMS.map((p) => <th key={p.id} scope="col" title={p.hint}>{p.label}</th>)}</tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k}>
                  <th scope="row">{nameOf(k)}</th>
                  {PERMS.map((p) => (
                    <td key={p.id}>
                      <select className={`perm-${grid[k][p.id]}`} aria-label={`${nameOf(k)}: ${p.label}`} value={grid[k][p.id]} onChange={(e) => set(k, p.id, e.target.value as Choice)}>
                        <option value="inherit">Inherit</option>
                        <option value="allow">Allow</option>
                        <option value="deny">Deny</option>
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="save-row">
        <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save permissions"}</button>
        {flash && <span className="saved">Saved ✓</span>}
        {dirty && !busy && <button type="button" className="link" onClick={() => setGrid(JSON.parse(JSON.stringify(saved)))}>Undo changes</button>}
      </div>
    </div>
  );
}
