/**
 * Custom themes (desktop app only). A theme is a full color scheme plus optional background pictures. Everything is
 * stored on this computer: the theme settings in localStorage and the pictures (chosen from your own files) in
 * IndexedDB. Nothing is uploaded to the server.
 */
export type ThemeColorKey = "bg" | "panel" | "surface2" | "hover" | "line" | "text" | "dim" | "accent" | "rail" | "side" | "sideText" | "sideDim";
export type ImageSlot = "app" | "chat" | "side";

export const COLOR_INFO: { key: ThemeColorKey; label: string; cssVar: string }[] = [
  { key: "bg", label: "Window background", cssVar: "--bg" },
  { key: "panel", label: "Chat area", cssVar: "--panel" },
  { key: "surface2", label: "Raised panels", cssVar: "--surface2" },
  { key: "hover", label: "Hover highlight", cssVar: "--hover" },
  { key: "line", label: "Borders", cssVar: "--line" },
  { key: "text", label: "Text", cssVar: "--text" },
  { key: "dim", label: "Muted text", cssVar: "--dim" },
  { key: "accent", label: "Accent (buttons, links)", cssVar: "--accent" },
  { key: "rail", label: "Server bar", cssVar: "--rail" },
  { key: "side", label: "Channel sidebar", cssVar: "--side" },
  { key: "sideText", label: "Sidebar text", cssVar: "--side-text" },
  { key: "sideDim", label: "Sidebar muted text", cssVar: "--side-dim" },
];
export type ThemeColors = Record<ThemeColorKey, string>;

export interface CustomTheme {
  id: string;
  name: string;
  /** Decides which built-in styles (light or dark) fill in anything a theme doesn't set. */
  base: "light" | "dark";
  colors: ThemeColors;
  /** Which pictures this theme has (the pictures themselves live in IndexedDB). */
  images: Partial<Record<ImageSlot, boolean>>;
  /** How solid the panels are over a window-wide picture, 30 to 100. */
  panelOpacity: number;
  /** Blur behind panels over a window-wide picture, in pixels, 0 to 24. */
  blur: number;
  /** How much panel color covers the chat / sidebar pictures, 0 to 95. */
  tint: number;
}

export const PRESETS: { id: string; name: string; base: "light" | "dark"; colors: ThemeColors }[] = [
  { id: "midnight", name: "Midnight", base: "dark", colors: { bg: "#0b0e17", panel: "#121726", surface2: "#171d30", hover: "#1f2740", line: "#263052", text: "#e8ecf8", dim: "#8f9bbd", accent: "#7c8cff", rail: "#070a12", side: "#0e1220", sideText: "#d9def0", sideDim: "#7f8aad" } },
  { id: "sunset", name: "Sunset", base: "dark", colors: { bg: "#1b1220", panel: "#241829", surface2: "#2c1d31", hover: "#3a2641", line: "#4a3152", text: "#fbeaf0", dim: "#c79fb2", accent: "#ff7a59", rail: "#140c18", side: "#1e1323", sideText: "#f6dce6", sideDim: "#b98aa0" } },
  { id: "forest", name: "Forest", base: "dark", colors: { bg: "#0f1a14", panel: "#14221a", surface2: "#1a2b21", hover: "#234032", line: "#2b4a38", text: "#e6f3ea", dim: "#8fb29c", accent: "#3fbf7f", rail: "#0a120d", side: "#101d15", sideText: "#d6ecde", sideDim: "#7fa68d" } },
  { id: "paper", name: "Paper", base: "light", colors: { bg: "#f5f0e6", panel: "#fffdf7", surface2: "#f8f2e4", hover: "#efe6d2", line: "#e0d5bb", text: "#2b2417", dim: "#7a6c4f", accent: "#b5651d", rail: "#e8dfc9", side: "#f0e8d4", sideText: "#2b2417", sideDim: "#7a6c4f" } },
  { id: "rose", name: "Rose", base: "light", colors: { bg: "#fdf1f4", panel: "#ffffff", surface2: "#fff7f9", hover: "#fbe3ea", line: "#f2cfd9", text: "#3a1f29", dim: "#8d5c6c", accent: "#d6336c", rail: "#f6d9e1", side: "#fbe7ed", sideText: "#3a1f29", sideDim: "#8d5c6c" } },
  { id: "contrast", name: "High contrast", base: "dark", colors: { bg: "#000000", panel: "#000000", surface2: "#0d0d0d", hover: "#1f1f1f", line: "#ffffff", text: "#ffffff", dim: "#d0d0d0", accent: "#ffd400", rail: "#000000", side: "#000000", sideText: "#ffffff", sideDim: "#d0d0d0" } },
];

const THEMES_KEY = "huddle.themes";
const ACTIVE_KEY = "huddle.activeTheme";
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n: unknown, lo: number, hi: number, fallback: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback);

/** Theme editing is only offered in the desktop app. */
export const themesAvailable = () => typeof window !== "undefined" && !!window.huddleDesktop;

export function makeTheme(name: string, preset = PRESETS[0]): CustomTheme {
  return { id: crypto.randomUUID(), name: name.slice(0, 40) || "My theme", base: preset.base, colors: { ...preset.colors }, images: {}, panelOpacity: 82, blur: 8, tint: 70 };
}

/** Accepts only a well-formed theme: anything unexpected is dropped or replaced with a safe default. */
export function cleanTheme(raw: any, id = crypto.randomUUID()): CustomTheme | null {
  if (!raw || typeof raw !== "object") return null;
  const base = raw.base === "light" ? "light" : "dark";
  const fallback = (base === "light" ? PRESETS[3] : PRESETS[0]).colors;
  const colors = {} as ThemeColors;
  for (const { key } of COLOR_INFO) colors[key] = typeof raw.colors?.[key] === "string" && HEX.test(raw.colors[key]) ? raw.colors[key].toLowerCase() : fallback[key];
  const images: CustomTheme["images"] = {};
  for (const s of ["app", "chat", "side"] as ImageSlot[]) if (raw.images?.[s] === true) images[s] = true;
  return {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 40) : "My theme",
    base,
    colors,
    images,
    panelOpacity: clamp(raw.panelOpacity, 30, 100, 82),
    blur: clamp(raw.blur, 0, 24, 8),
    tint: clamp(raw.tint, 0, 95, 70),
  };
}

export function loadThemes(): CustomTheme[] {
  try {
    const list = JSON.parse(localStorage.getItem(THEMES_KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list.map((t) => cleanTheme(t, typeof t?.id === "string" ? t.id : undefined)).filter((t): t is CustomTheme => !!t).slice(0, 30);
  } catch {
    return [];
  }
}
export function saveThemes(list: CustomTheme[]) {
  try { localStorage.setItem(THEMES_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}
export const getActiveId = () => { try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; } };
export function setActiveId(id: string | null) {
  try { id ? localStorage.setItem(ACTIVE_KEY, id) : localStorage.removeItem(ACTIVE_KEY); } catch { /* storage unavailable */ }
}

/** "light" or "dark" if a custom theme is in use (so the system-theme setting must not override it), else null. */
export function activeThemeBase(): "light" | "dark" | null {
  if (!themesAvailable()) return null;
  const id = getActiveId();
  return id ? loadThemes().find((t) => t.id === id)?.base ?? null : null;
}

// ---------- pictures (IndexedDB, on this computer only) ----------
const DB_NAME = "huddle-themes";
const STORE = "images";
function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((res, rej) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  } finally {
    db.close();
  }
}
const imageKey = (themeId: string, slot: ImageSlot) => `${themeId}:${slot}`;

/** Shrinks a picked image so it stays quick to draw, and returns it as a data URL (the page may show data: images). */
export async function prepareImage(file: File, maxWidth = 1920): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 25 * 1024 * 1024) throw new Error("That image is over 25 MB.");
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bmp.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/webp", 0.85);
}
export const saveImage = (themeId: string, slot: ImageSlot, dataUrl: string) => idb("readwrite", (s) => s.put(dataUrl, imageKey(themeId, slot))).then(() => undefined);
export const removeImage = (themeId: string, slot: ImageSlot) => idb("readwrite", (s) => s.delete(imageKey(themeId, slot))).then(() => undefined);
export async function loadImages(themeId: string): Promise<Partial<Record<ImageSlot, string>>> {
  const out: Partial<Record<ImageSlot, string>> = {};
  for (const slot of ["app", "chat", "side"] as ImageSlot[]) {
    try {
      const v = await idb<unknown>("readonly", (s) => s.get(imageKey(themeId, slot)));
      if (typeof v === "string" && /^data:image\/(png|jpeg|webp|gif);base64,/.test(v)) out[slot] = v;
    } catch { /* unavailable: no picture */ }
  }
  return out;
}

// ---------- applying a theme ----------
const applied = new Set<string>();
const root = () => document.documentElement;
function setVar(name: string, value: string) {
  root().style.setProperty(name, value);
  applied.add(name);
}

/** Black or white, whichever reads better on this color. */
export function inkFor(hex: string): "#111111" | "#ffffff" {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#111111" : "#ffffff";
}

export function clearTheme() {
  for (const name of applied) root().style.removeProperty(name);
  applied.clear();
  delete root().dataset.customTheme;
  for (const s of ["app", "chat", "side"]) delete root().dataset[`bg${s[0].toUpperCase()}${s.slice(1)}`];
}

export function applyTheme(theme: CustomTheme, images: Partial<Record<ImageSlot, string>> = {}) {
  clearTheme();
  const r = root();
  r.dataset.theme = theme.base;
  r.dataset.customTheme = theme.id;
  for (const { key, cssVar } of COLOR_INFO) setVar(cssVar, theme.colors[key]);
  // Everything else is worked out from those colors.
  setVar("--accent-ink", inkFor(theme.colors.accent));
  setVar("--accent-hover", "color-mix(in srgb, var(--accent) 82%, black)");
  setVar("--accent-soft", "color-mix(in srgb, var(--accent) 18%, var(--panel))");
  setVar("--chip", "color-mix(in srgb, var(--accent) 22%, var(--panel))");
  setVar("--chip-ink", "var(--text)");
  setVar("--mention-bg", "color-mix(in srgb, var(--accent) 14%, var(--panel))");
  setVar("--mention-bar", "var(--accent)");
  setVar("--side-line", "color-mix(in srgb, var(--side-text) 14%, transparent)");
  setVar("--side-hover", "color-mix(in srgb, var(--side-text) 9%, transparent)");
  setVar("--side-active", "color-mix(in srgb, var(--accent) 30%, transparent)");
  setVar("--side-active-text", "var(--side-text)");
  setVar("--side-me", "color-mix(in srgb, var(--side-text) 7%, transparent)");
  setVar("--rail-ring", "var(--side-text)");
  setVar("--rail-dash", "var(--side-dim)");
  setVar("--toast-bg", "var(--rail)");
  setVar("--theme-panel-opacity", `${theme.panelOpacity}%`);
  setVar("--theme-blur", `${theme.blur}px`);
  setVar("--theme-tint", `${theme.tint}%`);
  for (const slot of ["app", "chat", "side"] as ImageSlot[]) {
    const url = images[slot];
    if (!url || !theme.images[slot]) continue;
    setVar(`--theme-image-${slot}`, `url("${url}")`);
    r.dataset[`bg${slot[0].toUpperCase()}${slot.slice(1)}`] = "1";
  }
}

/** Colors straight away (no flash), pictures as soon as they have loaded. Does nothing outside the desktop app. */
export async function applyActiveTheme() {
  if (!themesAvailable()) return;
  const id = getActiveId();
  const theme = id ? loadThemes().find((t) => t.id === id) : null;
  if (!theme) return clearTheme();
  applyTheme(theme);
  const images = await loadImages(theme.id);
  if (Object.keys(images).length && getActiveId() === theme.id) applyTheme(theme, images);
}

// ---------- sharing a theme as a file ----------
export interface ThemeFile { format: "huddle-theme"; version: 1; theme: Omit<CustomTheme, "id">; images: Partial<Record<ImageSlot, string>> }

export async function exportTheme(theme: CustomTheme): Promise<ThemeFile> {
  const { id: _id, ...rest } = theme;
  void _id;
  return { format: "huddle-theme", version: 1, theme: rest, images: await loadImages(theme.id) };
}

/** Reads a theme file someone sent you. Colors and pictures are checked; anything odd is refused or reset. */
export function parseThemeFile(text: string): { theme: CustomTheme; images: Partial<Record<ImageSlot, string>> } {
  if (text.length > 20 * 1024 * 1024) throw new Error("That file is too big to be a theme.");
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error("That isn't a Huddle theme file."); }
  if (raw?.format !== "huddle-theme" || raw.version !== 1) throw new Error("That isn't a Huddle theme file.");
  const images: Partial<Record<ImageSlot, string>> = {};
  for (const slot of ["app", "chat", "side"] as ImageSlot[]) {
    const v = raw.images?.[slot];
    if (typeof v === "string" && v.length < 8 * 1024 * 1024 && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) images[slot] = v;
  }
  const theme = cleanTheme({ ...raw.theme, images: Object.fromEntries(Object.keys(images).map((s) => [s, true])) });
  if (!theme) throw new Error("That isn't a Huddle theme file.");
  return { theme, images };
}
