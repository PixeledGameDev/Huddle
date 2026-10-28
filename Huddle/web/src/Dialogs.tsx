import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo";

/**
 * Huddle's own confirm / prompt / alert boxes, used instead of the browser's (which look out of place and can be
 * switched off by the browser). They return promises, so: `if (!(await confirmDialog("Delete this?"))) return;`
 */
interface Options {
  title?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  defaultValue?: string;
  placeholder?: string;
  maxLength?: number;
}
type Request = Options & { id: number; kind: "confirm" | "prompt" | "alert"; message: string; resolve: (v: any) => void };

let nextId = 1;
let push: ((r: Request) => void) | null = null;
const backlog: Request[] = []; // asked before the host mounted

function ask<T>(kind: Request["kind"], message: string, opts: Options = {}) {
  return new Promise<T>((resolve) => {
    const r: Request = { ...infer(kind, message, opts), id: nextId++, kind, resolve };
    if (push) push(r);
    else backlog.push(r);
  });
}

const VERBS: [RegExp, string][] = [
  [/^(permanently )?delete/i, "Delete"], [/^remove/i, "Remove"], [/^block/i, "Block"], [/^leave/i, "Leave"], [/^(permanently )?ban\b/i, "Ban"],
  [/^close/i, "Close"], [/^send/i, "Send"], [/^start/i, "Start"], [/^turn off/i, "Turn off"], [/^end/i, "End"],
];
const DESTRUCTIVE = /^(permanently )?(delete|remove|block|leave|ban|turn off|end)\b|can't be undone|permanently/i;

/** Works out a heading, detail and button label from a plain sentence, so call sites can stay one line. */
function infer(kind: Request["kind"], message: string, o: Options): Options & { message: string } {
  let title = o.title;
  let detail = o.detail;
  let head = message;
  if (!title && !detail && kind !== "prompt") {
    const m = /^(.+?[?.])\s+(.+)$/s.exec(message);
    if (m) { head = m[1]; detail = m[2]; }
  }
  const verb = VERBS.find(([re]) => re.test(message))?.[1];
  return {
    ...o,
    title,
    detail,
    message: head,
    danger: o.danger ?? (kind === "confirm" && DESTRUCTIVE.test(message)),
    confirmLabel: o.confirmLabel ?? (kind === "alert" ? "OK" : kind === "prompt" ? "OK" : verb ?? "Confirm"),
    cancelLabel: o.cancelLabel ?? "Cancel",
  };
}

export const confirmDialog = (message: string, opts?: Options) => ask<boolean>("confirm", message, opts);
export const promptDialog = (message: string, opts?: Options) => ask<string | null>("prompt", message, opts);
export const alertDialog = (message: string, opts?: Options) => ask<void>("alert", message, opts);

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    if (backlog.length) setQueue((q) => [...q, ...backlog.splice(0)]);
    return () => { push = null; };
  }, []);
  const cur = queue[0];
  if (!cur) return null;
  return <DialogCard key={cur.id} req={cur} done={(v) => { cur.resolve(v); setQueue((q) => q.slice(1)); }} />;
}

function DialogCard({ req, done }: { req: Request; done: (v: any) => void }) {
  const [value, setValue] = useState(req.defaultValue ?? "");
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelValue = req.kind === "confirm" ? false : req.kind === "prompt" ? null : undefined;
  const confirmValue = () => (req.kind === "prompt" ? value.trim() : true);

  useEffect(() => {
    const was = document.activeElement as HTMLElement | null;
    if (req.kind === "prompt") { inputRef.current?.focus(); inputRef.current?.select(); }
    else (req.danger ? cancelRef.current : okRef.current)?.focus(); // a destructive box starts on the safe choice
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(req.kind === "alert" ? undefined : cancelValue); }
      else if (e.key === "Tab") {
        const els = [...document.querySelectorAll<HTMLElement>(".dlg button, .dlg input")];
        if (!els.length) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey, true); // capture, so Escape closes this and not the window behind it
    return () => { window.removeEventListener("keydown", onKey, true); was?.focus?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (req.kind === "prompt" && !value.trim()) return;
    done(confirmValue());
  };

  return (
    <div className="backdrop dlg-backdrop" onMouseDown={() => req.kind !== "prompt" && done(req.kind === "alert" ? undefined : cancelValue)}>
      <form className="dlg" role={req.kind === "alert" ? "alertdialog" : "dialog"} aria-modal="true" aria-label={req.title ?? req.message} onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <span className={`dlg-ico${req.danger ? " danger" : ""}`} aria-hidden="true">{req.danger ? "!" : <Logo />}</span>
        <h2>{req.title ?? req.message}</h2>
        {req.title && <p>{req.message}</p>}
        {req.detail && <p className="dlg-detail">{req.detail}</p>}
        {req.kind === "prompt" && (
          <input ref={inputRef} value={value} onChange={(e) => setValue(e.target.value)} placeholder={req.placeholder} maxLength={req.maxLength ?? 100} aria-label={req.message} autoComplete="off" />
        )}
        <div className="dlg-actions">
          {req.kind !== "alert" && <button type="button" ref={cancelRef} className="pill" onClick={() => done(cancelValue)}>{req.cancelLabel}</button>}
          <button ref={okRef} className={req.danger ? "danger-fill" : "primary"} disabled={req.kind === "prompt" && !value.trim()}>{req.confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}
