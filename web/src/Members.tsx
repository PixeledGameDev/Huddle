import { Avatar } from "./Avatar";
import { Name } from "./Name";
import { StatusDot } from "./Status";
import { can, canModerateMember, memberColor } from "./permissions";
import type { Member, ServerDetail, User, Vote } from "./types";
import { actionVerb, nameOfUser } from "./util";

interface Props {
  server: ServerDetail;
  me: User;
  votes: Vote[];
  onStartVote: (m: Member) => void;
  onRoles: (m: Member) => void;
  onOpenProfile: (userId: string) => void;
  onModerate: (m: Member) => void;
  onMessage: (userId: string) => void;
}

export default function Members({ server, me, votes, onStartVote, onRoles, onOpenProfile, onModerate, onMessage }: Props) {
  const online = server.members.filter((m) => m.online);
  const offline = server.members.filter((m) => !m.online);
  const voteOpenOn = (id: string) => votes.some((v) => v.status === "open" && v.targetId === id);
  const staff = (m: Member) => m.role !== "member" || m.roleIds.some((id) => server.roles.find((r) => r.id === id)?.permissions.some((p) => p !== "mention_everyone" && p !== "view_audit_log"));
  const canGiveRoles = (m: Member) => can(server, "manage_roles") && m.role !== "owner" && server.roles.length > 0 && (m.id === me.id || server.myTop > m.top);

  const row = (m: Member) => {
    const timedOut = m.timeoutUntil && new Date(m.timeoutUntil) > new Date();
    const name = nameOfUser(m);
    const color = memberColor(server, m);
    const roles = m.roleIds.map((id) => server.roles.find((r) => r.id === id)).filter((r) => !!r);
    return (
      <li key={m.id} className={m.online ? "member" : "member off"}>
        <button className="member-id" onClick={() => onOpenProfile(m.id)} title={`View ${name}'s profile`}>
          <span className="avatar-wrap"><Avatar id={m.id} name={name} version={m.avatarVersion} accent={m.accent} size={28} /><StatusDot status={m.status ?? (m.online ? "online" : "offline")} /></span>
          <span className="member-name">
            <span className="member-line">
              <span style={color ? { color } : undefined}><Name user={m} /></span>
              {m.role !== "member" && <em className="tag">{m.role}</em>}
              {roles.slice(0, 2).map((r) => (
                <em key={r!.id} className="tag role-tag"><i className="role-dot" style={{ background: r!.color ?? "var(--dim)" }} />{r!.name}</em>
              ))}
              {roles.length > 2 && <em className="tag">+{roles.length - 2}</em>}
              {timedOut && <em className="tag warn">timed out</em>}
            </span>
            {m.statusText && <small className="member-status">{m.statusText}</small>}
          </span>
        </button>
        <span className="member-actions">
          {m.id !== me.id && <button onClick={() => onMessage(m.id)}>Message</button>}
          {server.settings.voteEnabled && !staff(m) && m.id !== me.id && (
            voteOpenOn(m.id) ? <small>Vote open</small> : <button onClick={() => onStartVote(m)}>Vote to {actionVerb(server.settings.voteAction)}</button>
          )}
          {canModerateMember(server, me.id, m) && <button className="danger" onClick={() => onModerate(m)}>Moderate</button>}
          {canGiveRoles(m) && <button onClick={() => onRoles(m)}>Roles</button>}
        </span>
      </li>
    );
  };

  return (
    <aside className="members" aria-label="Members">
      <h3>Online · {online.length}</h3>
      <ul>{online.map(row)}</ul>
      {offline.length > 0 && (
        <>
          <h3>Offline · {offline.length}</h3>
          <ul>{offline.map(row)}</ul>
        </>
      )}
    </aside>
  );
}
