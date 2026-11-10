import { useEffect, useRef, useState } from "react";
import type { Member, SlashCommand } from "./types";
import { nameOfUser } from "./util";
import { Icon } from "./Icon";

/**
 * The boxes that appear in the message bar after picking a slash command: one per option, so nobody has to know
 * the options exist. Text options get a text box, choices a drop-down, "user" a name box that suggests members, "role" a drop-down of the server's roles.
 */
export function CommandForm({ cmd, roles, members, onRun, onCancel }: {
  cmd: SlashCommand;
  roles: { id: string; name: string }[];
  members: Member[];
  onRun: (values: Record<string, string>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const set = (k: string, v: string) => { setErr(""); setValues((s) => ({ ...s, [k]: v })); };

  useEffect(() => { formRef.current?.querySelector<HTMLElement>("input, select")?.focus(); }, [cmd.botId, cmd.name]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const out: Record<string, string> = {};
    for (const o of cmd.options) {
      let v = (values[o.name] ?? "").trim();
      if (!v) {
        if (o.required) return setErr(`Fill in “${o.name}”.`);
        continue;
      }
      if (o.type === "user") {
        const want = v.replace(/^@/, "").toLowerCase();
        const m = members.find((x) => x.username.toLowerCase() === want || nameOfUser(x).toLowerCase() === want);
        if (!m) return setErr(`Pick someone from the list for “${o.name}”.`);
        v = m.id;
      }
      out[o.name] = v;
    }
    setBusy(true);
    try { await onRun(out); } finally { setBusy(false); }
  }

  return (
    <form ref={formRef} className="cmd-form" onSubmit={(e) => void submit(e)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }} aria-label={`Options for /${cmd.name}`}>
      <div className="cmd-head">
        <strong>/{cmd.name}</strong>
        <small className="muted">{cmd.description} · {cmd.botDisplayName}</small>
        <button type="button" className="icon ghost" aria-label="Cancel command" onClick={onCancel}><Icon name="close" /></button>
      </div>
      <div className="cmd-fields">
        {cmd.options.map((o) => {
          const label = <span className="cmd-label">{o.name}{o.required ? <b title="Required"> *</b> : <i> optional</i>}</span>;
          const list = `cmd-${cmd.botId}-${cmd.name}-${o.name}`;
          let control: React.ReactNode;
          if (o.type === "boolean") control = (
            <select value={values[o.name] ?? ""} onChange={(e) => set(o.name, e.target.value)}>
              {!o.required && <option value="">—</option>}<option value="true">Yes</option><option value="false">No</option>
            </select>
          );
          else if (o.type === "role") control = (
            <select value={values[o.name] ?? ""} onChange={(e) => set(o.name, e.target.value)}>
              <option value="">{o.required ? "Choose a role…" : "—"}</option>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          );
          else if (o.type === "string" && o.choices?.length) control = (
            <select value={values[o.name] ?? ""} onChange={(e) => set(o.name, e.target.value)}>
              <option value="">{o.required ? "Choose…" : "—"}</option>
              {o.choices.map((c) => <option key={c.value} value={c.value}>{c.name}</option>)}
            </select>
          );
          else if (o.type === "user") control = (
            <>
              <input list={list} value={values[o.name] ?? ""} onChange={(e) => set(o.name, e.target.value)} placeholder="Start typing a name" autoComplete="off" />
              <datalist id={list}>{members.map((m) => <option key={m.id} value={m.username}>{nameOfUser(m)}</option>)}</datalist>
            </>
          );
          else if (o.type === "integer" || o.type === "number") control = (
            <input type="number" step={o.type === "integer" ? 1 : "any"} value={values[o.name] ?? ""} onChange={(e) => set(o.name, e.target.value)} />
          );
          else control = <input value={values[o.name] ?? ""} maxLength={1000} onChange={(e) => set(o.name, e.target.value)} />;
          return (
            <label key={o.name} className="cmd-field" title={o.description}>
              {label}
              {control}
              {o.description && <small className="muted">{o.description}</small>}
            </label>
          );
        })}
      </div>
      {err && <p className="notice" role="alert">{err}</p>}
      <div className="row"><button type="button" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy}>Run /{cmd.name}</button></div>
    </form>
  );
}
