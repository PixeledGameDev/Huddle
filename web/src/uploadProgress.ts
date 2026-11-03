/**
 * Keeps track of the files being uploaded right now, so the desktop app can show one progress bar on its taskbar button
 * (a few files at once count as one bar). Does nothing in a browser.
 */
interface Entry { loaded: number; total: number; done: boolean }
const entries = new Map<number, Entry>();
let seq = 0;
let lastSent = -2;

/** How far along everything is, 0 to 1, or -1 when nothing is being uploaded. Finished files stay in the sum until all are finished. */
export function combinedProgress(list: Iterable<Pick<Entry, "loaded" | "total">>): number {
  let loaded = 0;
  let total = 0;
  let n = 0;
  for (const e of list) {
    loaded += Math.min(e.loaded, e.total);
    total += e.total;
    n++;
  }
  return n === 0 ? -1 : total > 0 ? loaded / total : 0;
}

function publish() {
  const f = combinedProgress(entries.values());
  const rounded = f < 0 ? -1 : Math.round(f * 100) / 100;
  if (rounded === lastSent) return; // only tell the app when the bar would visibly move
  lastSent = rounded;
  window.huddleDesktop?.setProgress?.(rounded);
}

/** Call when an upload starts; report with progress(bytesSent) and finish with done() (also when it fails). */
export function trackUpload(totalBytes: number) {
  const id = ++seq;
  const entry: Entry = { loaded: 0, total: Math.max(1, totalBytes), done: false };
  entries.set(id, entry);
  publish();
  return {
    progress(loaded: number) {
      entry.loaded = loaded;
      publish();
    },
    done() {
      entry.loaded = entry.total;
      entry.done = true;
      if ([...entries.values()].every((e) => e.done)) entries.clear();
      publish();
    },
  };
}
