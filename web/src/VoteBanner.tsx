import { useEffect, useState } from "react";
import type { User, Vote } from "./types";
import { actionPhrase } from "./util";

export default function VoteBanner({ votes, me, onBallot }: { votes: Vote[]; me: User; onBallot: (v: Vote, choice: boolean) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  if (!votes.length) return null;

  return (
    <div className="votes" aria-live="polite">
      {votes.map((v) => {
        const secs = Math.max(0, Math.ceil((new Date(v.expiresAt).getTime() - now) / 1000));
        const pct = Math.min(100, (v.yes / v.requiredVotes) * 100);
        if (v.status !== "open") {
          return (
            <div key={v.id} className={`vote done ${v.status}`}>
              {v.status === "passed"
                ? `Vote passed: ${v.targetName} was ${v.action === "kick" ? "kicked" : v.action === "ban" ? "banned" : "timed out"}.`
                : `Vote failed: ${v.targetName} stays.`}
            </div>
          );
        }
        const isTarget = v.targetId === me.id;
        return (
          <div key={v.id} className="vote">
            <div className="vote-main">
              <strong>{v.initiatorName}</strong> started a vote to {actionPhrase(v)} <strong>{v.targetName}</strong>
              <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={v.requiredVotes} aria-valuenow={v.yes}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <small>
                {v.yes} of {v.requiredVotes} yes votes needed · {v.no} no · {secs}s left
              </small>
            </div>
            <div className="vote-actions">
              {isTarget ? (
                <small>This vote is about you.</small>
              ) : v.myVote === true || v.myVote === false ? (
                <small>You voted {v.myVote ? "yes" : "no"}.</small>
              ) : (
                <>
                  <button className="primary" onClick={() => onBallot(v, true)}>Yes</button>
                  <button onClick={() => onBallot(v, false)}>No</button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
