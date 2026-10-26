import { useState } from "react";
import { api, uploadRaw } from "./api";
import type { ServerDetail } from "./types";

type Kind = "emojis" | "stickers";

function Section({ server, kind, onError }: { server: ServerDetail; kind: Kind; onError: (e: unknown) => void }) {
  const items = kind === "emojis" ? server.emojis : server.stickers;
  const max = kind === "emojis" ? 50 : 20;
  const maxKb = kind === "emojis" ? 256 : 512;
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const singular = kind === "emojis" ? "emoji" : "sticker";

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      await uploadRaw(`/servers/${server.id}/${kind}?name=${encodeURIComponent(name.trim())}`, file, "POST");
      setName("");
      setFile(null);
    } catch (err) {
      onError(err);
    }
    setBusy(false);
  }
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (err) { onError(err); } };

  return (
    <div className="stack">
      <h3>{kind === "emojis" ? "Custom emoji" : "Stickers"} <small className="muted">{items.length}/{max}</small></h3>
      <p className="muted">
        {kind === "emojis"
          ? `Anyone in this server can use them in messages and reactions (type : then the name, or use the emoji picker). PNG, GIF, WebP or JPEG up to ${maxKb} KB; small square images work best.`
          : `Stickers are sent as a message on their own from the sticker button next to the message box. PNG, GIF, WebP or JPEG up to ${maxKb} KB.`}
      </p>
      <form className="emoji-add" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${kind === "emojis" ? "Emoji" : "Sticker"} name`} maxLength={32} pattern="[A-Za-z0-9_]{2,32}" title="2 to 32 letters, numbers or underscores" required />
        <label className="file-btn">{file ? file.name.slice(0, 24) : "Choose image"}<input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} /></label>
        <button className="primary" disabled={busy || !file || !name.trim()}>Add {singular}</button>
      </form>
      <ul className={kind === "emojis" ? "asset-grid emoji-grid" : "asset-grid sticker-grid"}>
        {items.length === 0 && <li className="muted">None yet.</li>}
        {items.map((it) => (
          <li key={it.id}>
            <img src={`/api/${kind}/${it.id}`} alt={it.name} loading="lazy" />
            <span className="asset-name" title={it.name}>:{it.name}:</span>
            <span className="asset-tools">
              <button className="link" onClick={() => { const n = window.prompt(`New name for :${it.name}:`, it.name); if (n && n !== it.name) void run(() => api(`/servers/${server.id}/${kind}/${it.id}`, "PATCH", { name: n })); }}>Rename</button>
              <button className="link danger" onClick={() => { if (window.confirm(`Delete :${it.name}:? Messages that used it will show its name instead.`)) void run(() => api(`/servers/${server.id}/${kind}/${it.id}`, "DELETE")); }}>Delete</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EmojiTab({ server, onError }: { server: ServerDetail; onError: (e: unknown) => void }) {
  return (
    <div className="stack">
      <Section server={server} kind="emojis" onError={onError} />
      <hr />
      <Section server={server} kind="stickers" onError={onError} />
    </div>
  );
}
