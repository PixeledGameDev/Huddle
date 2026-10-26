import { useEffect, useRef, useState } from "react";

export interface RosterRow<T> { item: T; state: "stay" | "enter" | "leave" }

/**
 * Keeps people who just disappeared from a list on screen for a moment (marked "leave") so they can animate out, and marks
 * people who just appeared as "enter". Nothing animates on the very first render.
 */
export function useRoster<T extends { id: string }>(items: T[], ms = 280): RosterRow<T>[] {
  const [rows, setRows] = useState<RosterRow<T>[]>(() => items.map((item) => ({ item, state: "stay" as const })));
  const timer = useRef<number | undefined>(undefined);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setRows((prev) => {
      const prevById = new Map(prev.map((r) => [r.item.id, r]));
      const nextIds = new Set(items.map((i) => i.id));
      const out: RosterRow<T>[] = items.map((item) => {
        const old = prevById.get(item.id);
        if (!old) return { item, state: "enter" };
        return { item, state: old.state === "leave" ? "enter" : old.state };
      });
      // People who left stay in the list, in the place they were, until their exit animation has played.
      prev.forEach((r, index) => {
        if (nextIds.has(r.item.id)) return;
        out.splice(Math.min(index, out.length), 0, { item: r.item, state: "leave" });
      });
      return out;
    });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setRows((r) => r.filter((x) => x.state !== "leave").map((x) => ({ ...x, state: "stay" }))), ms);
  }, [items, ms]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return rows;
}
