import { Avatar } from "./Avatar";
import { Name } from "./Name";
import { StatusDot } from "./Status";
import type { Member, ServerDetail, ServerRole } from "./types";
import { nameOfUser } from "./util";
import { useRoster } from "./useRoster";

interface Props {
  server: ServerDetail;
  onOpenProfile: (userId: string) => void;
  onClose: () => void;
}

interface Section { key: string; title: string; color: string | null; people: Member[]; dim?: boolean }

/** Owner first, then each role that has "show separately" switched on (highest rank first), then everyone else online, then offline. */
export function buildSections(server: ServerDetail): Section[] {
  const hoisted: ServerRole[] = server.roles.filter((r) => r.hoist).sort((a, b) => b.position - a.position);
  const sections: Section[] = [];
  const placed = new Set<string>();
  const online = server.members.filter((m) => m.online);

  const owners = online.filter((m) => m.role === "owner");
  if (owners.length) sections.push({ key: "owner", title: "Owner", color: null, people: owners });
  owners.forEach((m) => placed.add(m.id));

  const legacy = online.filter((m) => m.role === "admin" && !placed.has(m.id));
  if (legacy.length) sections.push({ key: "admin", title: "Admins", color: null, people: legacy });
  legacy.forEach((m) => placed.add(m.id));

  // Roles that share a section name share one section; a role without one is a section of its own, named after the role.
  const sectionOf = (r: ServerRole) => (r.sectionName?.trim() ? `n:${r.sectionName.trim().toLowerCase()}` : `r:${r.id}`);
  const done = new Set<string>();
  for (const role of hoisted) {
    const key = sectionOf(role);
    if (done.has(key)) continue; // an earlier (higher-ranked) role with the same section name already made it
    done.add(key);
    const group = hoisted.filter((h) => sectionOf(h) === key);
    // A person sits in the section of their highest-ranked role that is shown separately (roleIds are sorted highest first).
    const people = online.filter((m) => {
      if (placed.has(m.id)) return false;
      const top = m.roleIds.find((id) => hoisted.some((h) => h.id === id));
      return !!top && group.some((g) => g.id === top);
    });
    if (people.length) sections.push({ key, title: role.sectionName?.trim() || role.name, color: role.color, people });
    people.forEach((m) => placed.add(m.id));
  }
  const rest = online.filter((m) => !placed.has(m.id));
  if (rest.length) sections.push({ key: "online", title: "Online", color: null, people: rest });
  const offline = server.members.filter((m) => !m.online);
  if (offline.length) sections.push({ key: "offline", title: "Offline", color: null, people: offline, dim: true });
  return sections;
}

function Row({ m, server, state, onOpenProfile }: { m: Member; server: ServerDetail; state: string; onOpenProfile: (id: string) => void }) {
  const timedOut = m.timeoutUntil && new Date(m.timeoutUntil) > new Date();
  const color = (() => {
    for (const id of m.roleIds) {
      const r = server.roles.find((x) => x.id === id);
      if (r?.color) return r.color;
    }
    return null;
  })();
  return (
    <li className={`member ${m.online ? "" : "off"} ${state}`.trim()}>
      <button className="member-id" onClick={() => onOpenProfile(m.id)} title={`View ${nameOfUser(m)}'s profile`}>
        <span className="avatar-wrap"><Avatar id={m.id} name={nameOfUser(m)} version={m.avatarVersion} accent={m.accent} size={32} /><StatusDot status={m.status ?? (m.online ? "online" : "offline")} /></span>
        <span className="member-name">
          <span className="member-line"><span style={color ? { color } : undefined}><Name user={m} /></span>{timedOut && <em className="tag warn">timed out</em>}</span>
          {m.statusText && <small className="member-status">{m.statusText}</small>}
        </span>
      </button>
    </li>
  );
}

function SectionList({ section, server, onOpenProfile }: { section: Section; server: ServerDetail; onOpenProfile: (id: string) => void }) {
  const rows = useRoster(section.people);
  const count = section.people.length;
  return (
    <section className={section.dim ? "roster dim" : "roster"}>
      <h3 className="group"><i style={section.color ? { background: section.color } : undefined} />{section.title} · {count}</h3>
      <ul>{rows.map((r) => <Row key={r.item.id} m={r.item} server={server} state={r.state} onOpenProfile={onOpenProfile} />)}</ul>
    </section>
  );
}

export default function Members({ server, onOpenProfile, onClose }: Props) {
  const sections = buildSections(server);
  return (
    <aside className="members" aria-label="Members">
      <header className="members-top"><strong>Members</strong><button className="icon ghost show-sm" onClick={onClose} aria-label="Close member list">✕</button></header>
      {sections.map((s) => <SectionList key={s.key} section={s} server={server} onOpenProfile={onOpenProfile} />)}
    </aside>
  );
}
