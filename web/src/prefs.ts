export type Theme = "system" | "light" | "dark";
export type Density = "cozy" | "compact";
export interface Prefs { theme: Theme; density: Density }

const KEY = "huddle.prefs";

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { theme: ["system", "light", "dark"].includes(p.theme) ? p.theme : "system", density: p.density === "compact" ? "compact" : "cozy" };
  } catch {
    return { theme: "system", density: "cozy" };
  }
}

export function applyPrefs(p: Prefs) {
  const dark = p.theme === "dark" || (p.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.density = p.density;
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* storage unavailable */ }
  applyPrefs(p);
}
