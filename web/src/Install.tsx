import { useEffect, useState } from "react";

interface InstallPromptEvent extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> }

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e as InstallPromptEvent; listeners.forEach((l) => l()); });
window.addEventListener("appinstalled", () => { deferred = null; listeners.forEach((l) => l()); });

const standalone = () => window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/** Whether Huddle can be added to this device's home screen, and how. Nothing is offered inside the desktop app or once installed. */
export function useInstall() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  const hidden = !!window.huddleDesktop || standalone();
  return {
    /** Chrome and Edge can show their own install box. */
    canPrompt: !hidden && !!deferred,
    /** iPhones and iPads have no install box: the person adds it from the Share menu. */
    needsIosSteps: !hidden && !deferred && isIos(),
    prompt: async () => { const e = deferred; if (!e) return; await e.prompt(); await e.userChoice; deferred = null; listeners.forEach((l) => l()); },
  };
}
