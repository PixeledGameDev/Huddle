import "./fonts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { DialogHost } from "./Dialogs";
import { TitleBar } from "./TitleBar";
import { applyPrefs, loadPrefs } from "./prefs";
import { applyActiveTheme } from "./themes";
import "./styles.css";

applyPrefs(loadPrefs());
void applyActiveTheme();
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyPrefs(loadPrefs()));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TitleBar />
    <App />
    <DialogHost />
  </StrictMode>
);

// Lets Huddle be installed like an app. Skipped in the desktop app and while developing.
if ("serviceWorker" in navigator && import.meta.env.PROD && !window.huddleDesktop) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js").catch(() => {}); });
}
