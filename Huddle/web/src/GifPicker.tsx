import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { GifResult } from "./types";

export default function GifPicker({ onPick }: { onPick: (url: string) => void }) {
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (query: string, offset: number) => {
    setLoading(true);
    try {
      const path = query ? `/gifs/search?q=${encodeURIComponent(query)}&offset=${offset}` : `/gifs/trending?offset=${offset}`;
      const r = await api<{ gifs: GifResult[]; next: number | null }>(path);
      setGifs((prev) => (offset ? [...prev, ...r.gifs] : r.gifs));
      setNext(r.next);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "GIF search failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(q.trim(), 0), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <div className="gif-picker" onClick={(e) => e.stopPropagation()}>
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search GIFs" aria-label="Search GIFs" />
      {error && <p className="error">{error}</p>}
      <div className="gif-grid">
        {gifs.map((g) => (
          <button key={g.id} title={g.title} onClick={() => onPick(g.url)}>
            <img src={g.preview} alt={g.title || "GIF"} loading="lazy" />
          </button>
        ))}
      </div>
      {!error && !loading && gifs.length === 0 && <p className="muted pad">No GIFs found.</p>}
      <div className="gif-foot">
        {next !== null && <button className="link" disabled={loading} onClick={() => void load(q.trim(), next)}>Load more</button>}
        <small className="muted">Powered by GIPHY</small>
      </div>
    </div>
  );
}
