import { useEffect, useState } from "react";
import { Logo } from "./Logo";

/**
 * The desktop app has no system title bar or menu bar: this is its title bar. The logo opens the Huddle menu, the middle
 * shows where you are, and the empty space drags the window. The system draws only the minimize/maximize/close buttons
 * over the right-hand end (so Windows snap layouts keep working).
 */
export function TitleBar() {
  const bar = window.huddleDesktop?.titleBar;
  const [context, setContext] = useState(() => document.documentElement.dataset.context ?? "");

  useEffect(() => {
    if (!bar) return;
    const root = document.documentElement;
    const platform = window.huddleDesktop?.platform;
    document.body.classList.add("has-titlebar", platform === "darwin" ? "tb-mac" : "tb-win");
    root.style.setProperty("--titlebar-h", `${bar.height}px`);

    // Keep the window buttons' colors in step with the theme.
    const hex = /^#[0-9a-f]{6}$/i;
    const sync = () => {
      const cs = getComputedStyle(root);
      const bg = cs.getPropertyValue("--bg").trim();
      const text = cs.getPropertyValue("--text").trim();
      if (hex.test(bg) && hex.test(text)) bar.setColors(bg, text);
      setContext(root.dataset.context ?? "");
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-custom-theme", "data-context", "style"] });
    return () => {
      obs.disconnect();
      document.body.classList.remove("has-titlebar", "tb-mac", "tb-win");
      root.style.removeProperty("--titlebar-h");
    };
  }, [bar]);

  if (!bar) return null;
  return (
    <header className="titlebar">
      <button
        className="tb-logo"
        aria-haspopup="menu"
        aria-label="Huddle menu"
        title="Huddle menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          bar.openMenu(r.left, r.bottom + 4);
        }}
      >
        <Logo />
        <span className="tb-name">Huddle</span>
        <span className="tb-caret" aria-hidden="true">▾</span>
      </button>
      <span className="tb-title">{context}</span>
    </header>
  );
}
