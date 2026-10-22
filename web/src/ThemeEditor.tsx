import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modals";
import { applyActiveTheme, applyTheme, clearTheme, COLOR_INFO, PRESETS, exportTheme, getActiveId, loadImages, loadThemes, makeTheme, parseThemeFile, prepareImage, removeImage, saveImage, saveThemes, setActiveId, type CustomTheme, type ImageSlot, type ThemeColorKey } from "./themes";
import { applyPrefs, loadPrefs } from "./prefs";

const SLOTS: { slot: ImageSlot; label: string; help: string }[] = [
  { slot: "app", label: "Whole window", help: "Shows behind everything; the panels turn slightly see-through." },
  { slot: "chat", label: "Chat area", help: "Only behind the messages." },
  { slot: "side", label: "Channel sidebar", help: "Only behind the channel list." },
];

/** Design your own look: colors, background pictures from your own files, and sharing themes as files. Desktop app only. */
export function ThemeEditorModal({ onClose, onError, onNotice }: { onClose: () => void; onError: (e: unknown) => void; onNotice: (text: string) => void }) {
  const [themes, setThemes] = useState<CustomTheme[]>(loadThemes);
  const [activeId, setActive] = useState<string | null>(() => getActiveId());
  const [images, setImages] = useState<Partial<Record<ImageSlot, string>>>({});
  const [preset, setPreset] = useState(PRESETS[0].id);
  const fileRef = useRef<HTMLInputElement>(null);
  const current = themes.find((t) => t.id === activeId) ?? null;

  // Pictures for whichever theme is being edited.
  useEffect(() => {
    setImages({});
    if (current) void loadImages(current.id).then(setImages);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit(next: CustomTheme[], active: string | null, pics = images) {
    setThemes(next);
    saveThemes(next);
    setActive(active);
    setActiveId(active);
    const t = next.find((x) => x.id === active);
    if (t) applyTheme(t, pics);
    else {
      clearTheme();
      applyPrefs(loadPrefs());
    }
  }
  const update = (patch: Partial<CustomTheme>) => current && commit(themes.map((t) => (t.id === current.id ? { ...t, ...patch } : t)), current.id);
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { onError(e); } };

  async function pick(slot: ImageSlot, file: File) {
    if (!current) return;
    const url = await prepareImage(file);
    await saveImage(current.id, slot, url);
    const pics = { ...images, [slot]: url };
    setImages(pics);
    commit(themes.map((t) => (t.id === current.id ? { ...t, images: { ...t.images, [slot]: true } } : t)), current.id, pics);
  }
  async function drop(slot: ImageSlot) {
    if (!current) return;
    await removeImage(current.id, slot);
    const pics = { ...images };
    delete pics[slot];
    setImages(pics);
    const nextImages = { ...current.images };
    delete nextImages[slot];
    commit(themes.map((t) => (t.id === current.id ? { ...t, images: nextImages } : t)), current.id, pics);
  }
  async function remove() {
    if (!current || !window.confirm(`Delete the theme "${current.name}"?`)) return;
    for (const s of ["app", "chat", "side"] as ImageSlot[]) await removeImage(current.id, s).catch(() => {});
    commit(themes.filter((t) => t.id !== current.id), null);
  }
  async function duplicate() {
    if (!current) return;
    const copy = { ...current, id: crypto.randomUUID(), name: `${current.name} copy`.slice(0, 40), colors: { ...current.colors }, images: { ...current.images } };
    for (const [slot, url] of Object.entries(images)) await saveImage(copy.id, slot as ImageSlot, url);
    commit([...themes, copy], copy.id, images);
  }
  async function download() {
    if (!current) return;
    const file = await exportTheme(current);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
    a.download = `${current.name.replace(/[^\w-]+/g, "_") || "theme"}.huddle-theme.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function importFile(file: File) {
    const { theme, images: pics } = parseThemeFile(await file.text());
    if (themes.length >= 30) throw new Error("You can have up to 30 themes.");
    for (const [slot, url] of Object.entries(pics)) await saveImage(theme.id, slot as ImageSlot, url);
    setImages(pics);
    commit([...themes, theme], theme.id, pics);
    onNotice(`Imported "${theme.name}".`);
  }

  return (
    <Modal title="Custom themes" onClose={onClose}>
      <div className="stack">
        <p className="muted">Make Huddle look the way you like. Pictures come from your own computer and stay on it: they are never uploaded, so only you see your theme.</p>

        <div className="theme-bar">
          <select aria-label="Theme" value={activeId ?? ""} onChange={(e) => commit(themes, e.target.value || null)}>
            <option value="">Built-in theme (Profile &amp; appearance)</option>
            {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="theme-bar">
          <select aria-label="Start from" value={preset} onChange={(e) => setPreset(e.target.value)}>{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button className="primary" disabled={themes.length >= 30} onClick={() => { const p = PRESETS.find((x) => x.id === preset)!; const t = makeTheme(`${p.name} (mine)`, p); commit([...themes, t], t.id, {}); setImages({}); }}>New theme</button>
          <button onClick={() => fileRef.current?.click()}>Import…</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(() => importFile(f)); }} />
        </div>

        {current && (
          <>
            <hr />
            <label>Name<input value={current.name} maxLength={40} onChange={(e) => update({ name: e.target.value })} /></label>
            <div className="theme-bar">
              <div className="seg" role="group" aria-label="Light or dark">
                <button className={current.base === "light" ? "on" : ""} onClick={() => update({ base: "light" })}>Light base</button>
                <button className={current.base === "dark" ? "on" : ""} onClick={() => update({ base: "dark" })}>Dark base</button>
              </div>
              <select aria-label="Apply a color preset" value="" onChange={(e) => { const p = PRESETS.find((x) => x.id === e.target.value); if (p) update({ colors: { ...p.colors }, base: p.base }); }}>
                <option value="">Apply a preset's colors…</option>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>

            <h3>Colors</h3>
            <div className="color-grid">
              {COLOR_INFO.map(({ key, label }) => (
                <label key={key} className="color-cell">
                  <input type="color" value={current.colors[key]} onChange={(e) => update({ colors: { ...current.colors, [key as ThemeColorKey]: e.target.value } })} />
                  <span>{label}<small className="muted">{current.colors[key]}</small></span>
                </label>
              ))}
            </div>

            <h3>Background pictures</h3>
            {SLOTS.map(({ slot, label, help }) => (
              <div key={slot} className="image-slot">
                <div className="thumb" style={images[slot] ? { backgroundImage: `url("${images[slot]}")` } : undefined}>{!images[slot] && <span>None</span>}</div>
                <div className="stack tight">
                  <strong>{label}</strong>
                  <small className="muted">{help}</small>
                  <span className="row-actions">
                    <label className="file-btn">{images[slot] ? "Change picture…" : "Choose picture…"}<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void run(() => pick(slot, f)); }} /></label>
                    {images[slot] && <button type="button" className="link" onClick={() => void run(() => drop(slot))}>Remove</button>}
                  </span>
                </div>
              </div>
            ))}
            <div className="grid">
              <label>Panel solidity over a window picture: {current.panelOpacity}%<input type="range" min={30} max={100} value={current.panelOpacity} onChange={(e) => update({ panelOpacity: Number(e.target.value) })} /></label>
              <label>Blur behind panels: {current.blur}px<input type="range" min={0} max={24} value={current.blur} onChange={(e) => update({ blur: Number(e.target.value) })} /></label>
              <label>Color over chat and sidebar pictures: {current.tint}%<input type="range" min={0} max={95} value={current.tint} onChange={(e) => update({ tint: Number(e.target.value) })} /></label>
            </div>
            <p className="muted">Animated GIFs become still pictures. Large pictures are shrunk to fit.</p>

            <div className="row-actions">
              <button onClick={() => void run(download)}>Export to a file</button>
              <button onClick={() => void run(duplicate)}>Duplicate</button>
              <button className="danger" onClick={() => void run(remove)}>Delete theme</button>
            </div>
          </>
        )}
        {!current && themes.length === 0 && <p className="muted">No themes yet. Pick a preset above and choose New theme.</p>}
      </div>
    </Modal>
  );
}

/** Re-applies the saved theme (used when a window starts). */
export { applyActiveTheme };
