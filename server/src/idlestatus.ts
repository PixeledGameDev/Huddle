export type Chosen = "online" | "idle" | "dnd" | "invisible";
export type Shown = "online" | "idle" | "dnd" | "offline";

/**
 * How someone appears to other people, given what they chose, which connections they have open, and which of those
 * connections say their computer is idle. "Idle" is added only for someone who chose Online and whose every open
 * connection is idle, so one active device (a phone, another tab) keeps them Online. What they chose is never changed.
 */
export function effectiveStatus(chosen: Chosen, sockets: Iterable<string>, idle: ReadonlySet<string>): Shown {
  const ids = [...sockets];
  if (ids.length === 0 || chosen === "invisible") return "offline";
  if (chosen === "online" && ids.every((id) => idle.has(id))) return "idle";
  return chosen;
}
