import { activeThemeBase } from "./themes";
export type Theme = "system" | "light" | "dark";
export type Density = "cozy" | "compact";
export interface Prefs { theme: Theme; density: Density; lowMemory: boolean }

const KEY = "huddle.prefs";

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { theme: ["system", "light", "dark"].includes(p.theme) ? p.theme : "system", density: p.density === "compact" ? "compact" : "cozy", lowMemory: p.lowMemory === true };
  } catch {
    return { theme: "system", density: "cozy", lowMemory: false };
  }
}

export function applyPrefs(p: Prefs) {
  const custom = activeThemeBase(); // a custom theme (desktop app) decides light or dark itself
  const dark = custom ? custom === "dark" : p.theme === "dark" || (p.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.density = p.density;
  if (p.lowMemory) document.documentElement.dataset.lowmem = "1"; // see the "low memory mode" block in styles.css
  else delete document.documentElement.dataset.lowmem;
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
  applyPrefs(p);
}
