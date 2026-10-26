import "./fonts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
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
  </StrictMode>
);
