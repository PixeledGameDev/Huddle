import { useState } from "react";
import { confirmDialog } from "./Dialogs";
import { api } from "./api";
import { Modal } from "./Modals";
import { PERMISSION_INFO, canEditRole, can, isOwner } from "./permissions";
import type { Permission, ServerDetail } from "./types";

const PRESET_COLORS = ["#e74c3c", "#e67e22", "#f1c40f", "#2ecc71", "#1abc9c", "#3498db", "#9b59b6", "#e84393"];

interface Draft { name: string; color: string | null; permissions: Permission[]; hoist: boolean; selfAssignable: boolean }

/** Name, color and permission checkboxes. Permissions you don't hold yourself are locked (the owner holds all of them). */
function RoleForm({ server, initial, submitLabel, onSubmit, onCancel }: { server: ServerDetail; initial: Draft; submitLabel: string; onSubmit: (d: Draft) => Promise<void>; onCancel?: () => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);
  const toggle = (p: Permission) => setD((x) => ({ ...x, permissions: x.permissions.includes(p) ? x.permissions.filter((y) => y !== p) : [...x.permissions, p] }));
  return (
    <form
      className="stack role-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await onSubmit(d); } finally { setBusy(false); }
      }}
    >
      <label>Role name<input value={d.name} maxLength={32} onChange={(e) => setD({ ...d, name: e.target.value })} required /></label>
      <div className="stack tight">
        <span className="label-text">Color</span>
        <div className="swatches">
          <button type="button" className={d.color === null ? "swatch none on" : "swatch none"} title="No color" onClick={() => setD({ ...d, color: null })}>∅</button>
          {PRESET_COLORS.map((c) => <button key={c} type="button" className={d.color === c ? "swatch on" : "swatch"} style={{ background: c }} aria-label={c} onClick={() => setD({ ...d, color: c })} />)}
          <input type="color" className="swatch-input" value={d.color ?? "#99aab5"} onChange={(e) => setD({ ...d, color: e.target.value })} aria-label="Custom color" />
        </div>
      </div>
      <label className="check perm">
        <input type="checkbox" checked={d.hoist} onChange={(e) => setD({ ...d, hoist: e.target.checked })} />
        <span><strong>Show members with this role separately</strong><small className="muted">People who are online get their own section in the member list.</small></span>
      </label>
      <label className="check perm">
        <input type="checkbox" checked={d.selfAssignable} onChange={(e) => setD({ ...d, selfAssignable: e.target.checked, permissions: e.target.checked ? [] : d.permissions })} />
        <span><strong>Anyone can give themselves this role</strong><small className="muted">Handy for pick-your-own roles like pronouns or interests. Turns off the permissions below, since anyone could take it.</small></span>
      </label>
      <fieldset className="perm-list" disabled={d.selfAssignable}>
        <legend className="label-text">Permissions</legend>
        {PERMISSION_INFO.map((p) => {
          const held = server.myPermissions.includes(p.key);
          const on = d.permissions.includes(p.key);
          return (
            <label key={p.key} className="check perm">
              <input type="checkbox" checked={on} disabled={!held && !on} onChange={() => toggle(p.key)} />
              <span><strong>{p.label}</strong><small className="muted">{p.help}{!held && !on ? " (You don't have this permission yourself.)" : ""}</small></span>
            </label>
          );
        })}
      </fieldset>
      <div className="row-actions">
        <button className="primary" disabled={busy || !d.name.trim()}>{submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export function RolesTab({ server, onError }: { server: ServerDetail; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const roles = server.roles;
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { onError(e); } };
  const owner = isOwner(server);

  return (
    <div className="stack">
      <p className="muted">
        Roles give people separate permissions. Someone with several roles gets all of their permissions, and you can only change roles and people ranked below your highest role{owner ? "" : " (the owner outranks everyone)"}.
        Higher in the list means higher rank.
      </p>
      {can(server, "manage_roles") && editing !== "new" && <button className="primary" onClick={() => setEditing("new")}>Create role</button>}
      {editing === "new" && (
        <RoleForm
          server={server}
          initial={{ name: "", color: null, permissions: [], hoist: true, selfAssignable: false }}
          submitLabel="Create role"
          onCancel={() => setEditing(null)}
          onSubmit={async (d) => run(async () => { await api(`/servers/${server.id}/roles`, "POST", d); setEditing(null); })}
        />
      )}
      <ul className="rows roles-list">
        {roles.length === 0 && <li className="muted">No roles yet.</li>}
        {roles.map((r, i) => {
          const editable = canEditRole(server, r);
          return (
            <li key={r.id} className="role-item">
              <div className="role-line">
                <span className="role-name"><i className="role-dot big" style={{ background: r.color ?? "var(--dim)" }} />{r.name}<small className="muted"> · {r.memberCount} {r.memberCount === 1 ? "member" : "members"}</small></span>
                {editable ? (
                  <span className="role-tools">
                    <button className="icon" aria-label={`Move ${r.name} up`} title="Higher rank" disabled={i === 0 || !canEditRole(server, roles[i - 1])} onClick={() => run(() => api(`/servers/${server.id}/roles/${r.id}/move`, "POST", { direction: "up" }))}>↑</button>
                    <button className="icon" aria-label={`Move ${r.name} down`} title="Lower rank" disabled={i === roles.length - 1} onClick={() => run(() => api(`/servers/${server.id}/roles/${r.id}/move`, "POST", { direction: "down" }))}>↓</button>
                    <button onClick={() => setEditing(editing === r.id ? null : r.id)}>{editing === r.id ? "Close" : "Edit"}</button>
                    <button className="danger" onClick={async () => { if (await confirmDialog(`Delete the ${r.name} role? Everyone who has it loses it.`)) void run(() => api(`/servers/${server.id}/roles/${r.id}`, "DELETE")); }}>Delete</button>
                  </span>
                ) : <small className="muted">Ranked above you</small>}
              </div>
              {editing !== r.id && r.permissions.length > 0 && (
                <p className="perm-summary">{r.permissions.map((p) => PERMISSION_INFO.find((x) => x.key === p)?.label ?? p).join(" · ")}</p>
              )}
              {editing === r.id && (
                <RoleForm
                  server={server}
                  initial={{ name: r.name, color: r.color, permissions: r.permissions, hoist: r.hoist, selfAssignable: r.selfAssignable }}
                  submitLabel="Save role"
                  onSubmit={async (d) => run(async () => { await api(`/servers/${server.id}/roles/${r.id}`, "PATCH", d); setEditing(null); })}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Shown to the owner of a server that still has the old single "admin" rank. */
export function LegacyAdminsModal({ server, onClose, onDone, onError }: { server: ServerDetail; onClose: () => void; onDone: () => void; onError: (e: unknown) => void }) {
  const n = server.legacyAdminCount;
  const all = PERMISSION_INFO.map((p) => p.key).filter((k) => k !== "manage_roles");
  const [busy, setBusy] = useState(false);
  async function resolve(body: unknown) {
    setBusy(true);
    try { await api(`/servers/${server.id}/legacy-admins`, "POST", body); onDone(); } catch (e) { onError(e); setBusy(false); }
  }
  return (
    <Modal title="Admin is now a role" onClose={onClose}>
      <p>
        Huddle servers no longer have a single admin rank: powers now come from roles you design. <strong>{n} {n === 1 ? "person in this server is" : "people in this server are"} still an admin.</strong> They keep
        their access for now, but you should give them a role so you decide exactly what they can do.
      </p>
      <RoleForm
        server={server}
        initial={{ name: "Admin", color: "#3498db", permissions: all, hoist: true, selfAssignable: false }}
        submitLabel={`Create role and give it to ${n === 1 ? "them" : `all ${n}`}`}
        onSubmit={(d) => resolve({ mode: "role", role: d })}
      />
      <hr />
      <button className="danger" disabled={busy} onClick={async () => { if (await confirmDialog(`Remove admin from ${n === 1 ? "them" : `all ${n}`} without giving a role? They become regular members.`)) void resolve({ mode: "demote" }); }}>
        Remove their admin power instead
      </button>
      <p className="muted">Manage roles stays with you: an admin role can be given that permission later if you want.</p>
    </Modal>
  );
}
