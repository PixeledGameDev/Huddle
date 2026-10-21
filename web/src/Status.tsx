import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Presence, PublicStatus, User } from "./types";

export const STATUS_LABEL: Record<PublicStatus, string> = { online: "Online", idle: "Idle", dnd: "Do not disturb", offline: "Offline" };

export function StatusDot({ status, className = "" }: { status: PublicStatus; className?: string }) {
  return <span className={`dot st-${status} ${className}`} role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} />;
}

const CHOICES: { value: Presence; label: string; help: string }[] = [
  { value: "online", label: "Online", help: "" },
  { value: "idle", label: "Idle", help: "Shows a moon so people know you may be slow to answer." },
  { value: "dnd", label: "Do not disturb", help: "No pop-ups or sounds for new messages on this device." },
  { value: "invisible", label: "Invisible", help: "You appear offline but can still use everything." },
];

/** The little status button in the bottom-left corner. */
export function StatusMenu({ me, onUser, onError }: { me: User; onUser: (u: User) => void; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = me.presence ?? "online";
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", esc); };
  }, [open]);

  async function choose(p: Presence) {
    setOpen(false);
    if (p === current) return;
    try {
      const { user } = await api<{ user: User }>("/me/profile", "PATCH", { presence: p });
      onUser(user);
    } catch (e) { onError(e); }
  }
  const shown: PublicStatus = current === "invisible" ? "offline" : current;
  return (
    <div className="status-menu" ref={ref}>
      <button className="icon status-btn" aria-haspopup="menu" aria-expanded={open} title={`Status: ${CHOICES.find((c) => c.value === current)?.label}`} onClick={() => setOpen((o) => !o)}>
        <StatusDot status={shown} className="inline" />
      </button>
      {open && (
        <div className="menu" role="menu">
          {CHOICES.map((c) => (
            <button key={c.value} role="menuitemradio" aria-checked={c.value === current} className={c.value === current ? "on" : ""} onClick={() => void choose(c.value)}>
              <StatusDot status={c.value === "invisible" ? "offline" : c.value} className="inline" />
              <span><strong>{c.label}</strong>{c.help && <small>{c.help}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
