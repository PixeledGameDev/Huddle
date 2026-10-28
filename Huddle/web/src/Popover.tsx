import { useLayoutEffect, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * A menu that opens next to a button without ever being cut off. It's drawn on top of the whole page (not inside the sidebar,
 * which clips anything that sticks out), then placed beside the button and kept inside the window.
 */
export function Popover({ anchor, onClose, width = 250, className = "", label, children }: {
  anchor: React.RefObject<HTMLElement | null>; onClose: () => void; width?: number; className?: string; label?: string; children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; w: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const m = box.current;
      if (!a || !m) return;
      const gap = 8, pad = 8;
      const w = Math.min(width, window.innerWidth - pad * 2);
      const h = m.offsetHeight;
      // Line up with the button's left edge, but slide back in if that would run off the window.
      const left = Math.max(pad, Math.min(a.left, window.innerWidth - w - pad));
      // Open upward (the buttons live at the bottom of the screen) unless there isn't room.
      const above = a.top - gap - h >= pad;
      const top = above ? a.top - gap - h : Math.min(a.bottom + gap, Math.max(pad, window.innerHeight - h - pad));
      setPos({ left, top, w });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, width]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); anchor.current?.focus(); } };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={box}
      className={`menu popover ${className}`.trim()}
      role="menu"
      aria-label={label}
      style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, width: pos?.w ?? width, visibility: pos ? "visible" : "hidden", bottom: "auto", right: "auto", zIndex: 80 }}
    >
      {children}
    </div>,
    document.body
  );
}
