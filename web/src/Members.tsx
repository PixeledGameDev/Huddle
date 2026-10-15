import type { Member, ServerDetail, User, Vote } from "./types";
import { actionVerb, hue } from "./util";

interface Props {
  server: ServerDetail;
  me: User;
  votes: Vote[];
  onStartVote: (m: Member) => void;
  onRole: (m: Member, role: "admin" | "member") => void;
}

export default function Members({ server, me, votes, onStartVote, onRole }: Props) {
  const online = server.members.filter((m) => m.online);
  const offline = server.members.filter((m) => !m.online);
  const voteOpenOn = (id: string) => votes.some((v) => v.status === "open" && v.targetId === id);

  const row = (m: Member) => {
    const timedOut = m.timeoutUntil && new Date(m.timeoutUntil) > new Date();
    return (
      <li key={m.id} className={m.online ? "member" : "member off"}>
        <span className="avatar sm" style={{ background: `hsl(${hue(m.username)} 45% 42%)` }}>{m.username[0].toUpperCase()}</span>
        <span className="member-name">
          {m.username}
          {m.role !== "member" && <em className="tag">{m.role}</em>}
          {timedOut && <em className="tag warn">timed out</em>}
        </span>
        <span className="member-actions">
          {server.settings.voteEnabled && m.role === "member" && m.id !== me.id && (
            voteOpenOn(m.id) ? (
              <small>Vote open</small>
            ) : (
              <button onClick={() => onStartVote(m)}>Vote to {actionVerb(server.settings.voteAction)}</button>
            )
          )}
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
