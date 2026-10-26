import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface LightboxImage { id: string; name: string }

/** The picture viewer's markup. Download is top right, next to Close; ← → move between a message's pictures. */
export function LightboxView({
  images, index, onIndex, onClose, closeRef,
}: { images: LightboxImage[]; index: number; onIndex: (i: number) => void; onClose: () => void; closeRef?: React.Ref<HTMLButtonElement> }) {
  const img = images[index];
  const src = `/api/files/${img.id}`;
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Preview of ${img.name}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lb-bar">
        <a className="lb-btn" href={src} download={img.name} title="Download">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M5 21h14" /></svg>
          <span>Download</span>
        </a>
        <button type="button" className="lb-btn lb-close" ref={closeRef} onClick={onClose} aria-label="Close preview" title="Close (Esc)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {index > 0 && <button type="button" className="lb-nav lb-prev" onClick={() => onIndex(index - 1)} aria-label="Previous picture">‹</button>}
      {index < images.length - 1 && <button type="button" className="lb-nav lb-next" onClick={() => onIndex(index + 1)} aria-label="Next picture">›</button>}
      <img className="lb-img" src={src} alt={img.name} draggable={false} />
      <div className="lb-caption">{img.name}{images.length > 1 ? ` · ${index + 1} of ${images.length}` : ""}</div>
    </div>
  );
}

export function Lightbox(props: { images: LightboxImage[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const scroll = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const { index, images, onIndex, onClose } = latest.current;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      else if (e.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
      else if (e.key === "Tab") {
        // keep keyboard focus inside the viewer while it's open
        const items = Array.from(document.querySelectorAll<HTMLElement>(".lightbox a[href], .lightbox button"));
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : at === items.length - 1 ? 0 : at + 1;
        items[next].focus();
      } else return;
      e.preventDefault();
      e.stopPropagation(); // so the app's own Escape handling doesn't also fire
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = scroll;
      opener?.focus?.();
    };
  }, []);

  return createPortal(<LightboxView {...props} closeRef={closeRef} />, document.body);
}
