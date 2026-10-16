import { Avatar } from "./Avatar";
import type { Member, ServerDetail, User, Vote } from "./types";
import { actionVerb, nameOfUser } from "./util";

interface Props {
  server: ServerDetail;
  me: User;
  votes: Vote[];
  onStartVote: (m: Member) => void;
  onRole: (m: Member, role: "admin" | "member") => void;
  onOpenProfile: (userId: string) => void;
  onModerate: (m: Member) => void;
}

export default function Members({ server, me, votes, onStartVote, onRole, onOpenProfile, onModerate }: Props) {
  const online = server.members.filter((m) => m.online);
  const offline = server.members.filter((m) => !m.online);
  const voteOpenOn = (id: string) => votes.some((v) => v.status === "open" && v.targetId === id);
  const canModerate = (m: Member) =>
    m.id !== me.id && (server.myRole === "owner" ? m.role !== "owner" : server.myRole === "admin" ? m.role === "member" : false);

  const row = (m: Member) => {
    const timedOut = m.timeoutUntil && new Date(m.timeoutUntil) > new Date();
    const name = nameOfUser(m);
    return (
      <li key={m.id} className={m.online ? "member" : "member off"}>
        <button className="member-id" onClick={() => onOpenProfile(m.id)} title={`View ${name}'s profile`}>
          <Avatar id={m.id} name={name} version={m.avatarVersion} accent={m.accent} size={28} />
          <span className="member-name">
            <span className="member-line">
              {name}
              {m.role !== "member" && <em className="tag">{m.role}</em>}
              {timedOut && <em className="tag warn">timed out</em>}
            </span>
            {m.statusText && <small className="member-status">{m.statusText}</small>}
          </span>
        </button>
        <span className="member-actions">
          {server.settings.voteEnabled && m.role === "member" && m.id !== me.id && (
            voteOpenOn(m.id) ? <small>Vote open</small> : <button onClick={() => onStartVote(m)}>Vote to {actionVerb(server.settings.voteAction)}</button>
          )}
          {canModerate(m) && <button className="danger" onClick={() => onModerate(m)}>Moderate</button>}
          {server.myRole === "owner" && m.role !== "owner" && (
            <button onClick={() => onRole(m, m.role === "admin" ? "member" : "admin")}>{m.role === "admin" ? "Remove admin" : "Make admin"}</button>
          )}
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
