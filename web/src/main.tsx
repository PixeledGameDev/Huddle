import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyPrefs, loadPrefs } from "./prefs";
import "./styles.css";

applyPrefs(loadPrefs());
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyPrefs(loadPrefs()));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
