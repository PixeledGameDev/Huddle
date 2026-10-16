import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { emitServer, emitUser, leaveServerRooms, onlineIds } from "./realtime";

export interface VoteDto {
  id: string;
  serverId: string;
  targetId: string;
  targetName: string;
  initiatorId: string;
  initiatorName: string;
  action: "kick" | "timeout" | "ban";
  durationSeconds: number;
  requiredVotes: number;
  eligibleCount: number;
  status: "open" | "passed" | "failed";
  expiresAt: string;
  yes: number;
  no: number;
  myVote?: boolean | null;
}

/** viewerId = null produces the broadcast shape (no myVote). */
export async function fetchVote(id: string, viewerId: string | null = null): Promise<VoteDto | null> {
  const r = await one<any>(
    `select v.id, v.server_id, v.target_id, coalesce(t.display_name, t.username) as target_name, v.initiator_id, coalesce(i.display_name, i.username) as initiator_name,
            v.action, v.duration_seconds, v.required_votes, v.eligible_count, v.status, v.expires_at,
            (select count(*) from vote_ballots b where b.vote_id = v.id and b.choice)::int as yes,
            (select count(*) from vote_ballots b where b.vote_id = v.id and not b.choice)::int as no,
            (select choice from vote_ballots b where b.vote_id = v.id and b.user_id = $2) as my_vote
       from votes v
       join users t on t.id = v.target_id
       join users i on i.id = v.initiator_id
      where v.id = $1`,
    [id, viewerId]
  );
  if (!r) return null;
  const dto: VoteDto = {
    id: r.id,
    serverId: r.server_id,
    targetId: r.target_id,
    targetName: r.target_name,
    initiatorId: r.initiator_id,
    initiatorName: r.initiator_name,
    action: r.action,
    durationSeconds: r.duration_seconds,
    requiredVotes: r.required_votes,
    eligibleCount: r.eligible_count,
    status: r.status,
    expiresAt: new Date(r.expires_at).toISOString(),
    yes: r.yes,
    no: r.no,
  };
  if (viewerId) dto.myVote = r.my_vote;
  return dto;
}

export async function listOpenVotes(serverId: string, viewerId: string) {
  const rows = await q<{ id: string }>(`select id from votes where server_id = $1 and status = 'open' order by created_at`, [serverId]);
  const out: VoteDto[] = [];
  for (const r of rows) {
    const v = await fetchVote(r.id, viewerId);
    if (v) out.push(v);
  }
  return out;
}

async function activeTimeout(serverId: string, userId: string, c?: PoolClient) {
  return one<{ until: Date }>(`select until from server_timeouts where server_id = $1 and user_id = $2 and until > now()`, [serverId, userId], c);
}

/** Who may vote: any member except the target. Plain members must also be old enough. */
async function canVote(serverId: string, userId: string, minAgeSeconds: number, c?: PoolClient) {
  const m = await one<{ role: string; age: number }>(
    `select role, extract(epoch from (now() - joined_at))::int as age from memberships where server_id = $1 and user_id = $2`,
    [serverId, userId],
    c
  );
  if (!m) throw new HttpError(403, "You're not in this server.");
  if (m.role === "member" && m.age < minAgeSeconds)
    throw new HttpError(403, "You haven't been in this server long enough to vote.");
}

export async function startVote(serverId: string, initiatorId: string, targetId: string) {
  const voteId = await tx(async (c) => {
    const s = await one<any>(`select * from servers where id = $1`, [serverId], c);
    if (!s) throw new HttpError(404, "Server not found.");
    if (!s.vote_enabled) throw new HttpError(403, "Vote moderation is turned off in this server.");
    if (targetId === initiatorId) throw new HttpError(400, "You can't start a vote on yourself.");

    await canVote(serverId, initiatorId, s.vote_min_member_age_seconds, c);
    if (await activeTimeout(serverId, initiatorId, c)) throw new HttpError(403, "You can't start votes while timed out.");

    const target = await one<{ role: string }>(`select role from memberships where server_id = $1 and user_id = $2`, [serverId, targetId], c);
    if (!target) throw new HttpError(404, "That person isn't in this server.");
    if (target.role !== "member") throw new HttpError(403, "Owners and admins can't be voted on.");

    const recent = await one(
      `select 1 from votes where server_id = $1 and (target_id = $2 or initiator_id = $3)
         and created_at > now() - make_interval(secs => $4)`,
      [serverId, targetId, initiatorId, s.vote_cooldown_seconds],
      c
    );
    if (recent) throw new HttpError(429, "A vote involving this person was started recently. Try again later.");

    // Eligible voters = online members (plus the initiator) who are allowed to vote, excluding the target.
    const candidates = [...new Set([...onlineIds(), initiatorId])];
    const eligible = await q<{ user_id: string }>(
      `select user_id from memberships
        where server_id = $1 and user_id = any($2::uuid[]) and user_id <> $3
          and (role <> 'member' or joined_at <= now() - make_interval(secs => $4))`,
      [serverId, candidates, targetId, s.vote_min_member_age_seconds],
      c
    );
    if (eligible.length < s.vote_min_votes)
      throw new HttpError(409, `Not enough eligible members online. At least ${s.vote_min_votes} are needed.`);
    const required = Math.min(eligible.length, Math.max(s.vote_min_votes, Math.ceil((eligible.length * s.vote_threshold_pct) / 100)));

    try {
      const v = await one<{ id: string }>(
        `insert into votes(server_id, target_id, initiator_id, action, duration_seconds, required_votes, eligible_count, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8)) returning id`,
        [serverId, targetId, initiatorId, s.vote_action, s.vote_action === "kick" ? 0 : s.vote_duration_seconds, required, eligible.length, s.vote_window_seconds],
        c
      );
      await q(`insert into vote_ballots(vote_id, user_id, choice) values ($1, $2, true)`, [v!.id, initiatorId], c);
      await q(`insert into audit_log(server_id, actor_id, target_id, action, detail) values ($1, $2, $3, 'vote.start', $4)`, [
        serverId,
        initiatorId,
        targetId,
        JSON.stringify({ voteId: v!.id, action: s.vote_action }),
      ], c);
      return v!.id;
    } catch (e: any) {
      if (e.code === "23505") throw new HttpError(409, "A vote on this person is already open.");
      throw e;
    }
  });
  await evaluate(voteId);
  return fetchVote(voteId, initiatorId);
}

export async function castBallot(voteId: string, userId: string, choice: boolean) {
  const v = await one<any>(`select v.*, s.vote_min_member_age_seconds as min_age from votes v join servers s on s.id = v.server_id where v.id = $1`, [voteId]);
  if (!v) throw new HttpError(404, "Vote not found.");
  if (v.status !== "open" || new Date(v.expires_at) <= new Date()) throw new HttpError(409, "This vote has ended.");
  if (v.target_id === userId) throw new HttpError(403, "You can't vote on your own case.");
  await canVote(v.server_id, userId, v.min_age);
  const ins = await q(`insert into vote_ballots(vote_id, user_id, choice) values ($1, $2, $3) on conflict do nothing returning user_id`, [voteId, userId, choice]);
  if (!ins.length) throw new HttpError(409, "You already voted.");
  await evaluate(voteId);
  return fetchVote(voteId, userId);
}

/** Pass or fail early when the outcome is already decided; otherwise broadcast the tally. */
async function evaluate(voteId: string) {
  const v = await fetchVote(voteId);
  if (!v || v.status !== "open") return v;
  if (v.yes >= v.requiredVotes) return resolve(voteId, "passed");
  if (v.no > v.eligibleCount - v.requiredVotes) return resolve(voteId, "failed");
  emitServer(v.serverId, "vote.update", v);
  return v;
}

async function resolve(voteId: string, status: "passed" | "failed") {
  const applied = await tx(async (c) => {
    // The status guard means exactly one caller resolves a vote, even if the sweeper races a ballot.
    const v = await one<any>(`update votes set status = $2, resolved_at = now() where id = $1 and status = 'open' returning *`, [voteId, status], c);
    if (!v) return null;
    if (status === "passed") {
      if (v.action === "timeout") {
        await q(
          `insert into server_timeouts(server_id, user_id, until) values ($1, $2, now() + make_interval(secs => $3))
           on conflict (server_id, user_id) do update set until = excluded.until`,
          [v.server_id, v.target_id, v.duration_seconds],
          c
        );
      } else {
        if (v.action === "ban") {
          await q(
            `insert into server_bans(server_id, user_id, until) values ($1, $2, now() + make_interval(secs => $3))
             on conflict (server_id, user_id) do update set until = excluded.until`,
            [v.server_id, v.target_id, v.duration_seconds],
            c
          );
        }
        await q(`delete from memberships where server_id = $1 and user_id = $2`, [v.server_id, v.target_id], c);
      }
    }
    await q(`insert into audit_log(server_id, actor_id, target_id, action, detail) values ($1, $2, $3, $4, $5)`, [
      v.server_id,
      v.initiator_id,
      v.target_id,
      `vote.${status}`,
      JSON.stringify({ voteId, action: v.action, durationSeconds: v.duration_seconds }),
    ], c);
    return v;
  });
  const dto = await fetchVote(voteId);
  if (applied && dto) {
    if (status === "passed" && applied.action !== "timeout") {
      leaveServerRooms(applied.target_id, applied.server_id);
      emitUser(applied.target_id, "server.removed", { serverId: applied.server_id, reason: applied.action });
      emitServer(applied.server_id, "member.leave", { serverId: applied.server_id, userId: applied.target_id });
    } else if (status === "passed") {
      emitServer(applied.server_id, "member.update", { serverId: applied.server_id, userId: applied.target_id });
    }
    emitServer(applied.server_id, "vote.update", dto);
    if (status === "passed" && applied.action !== "timeout") emitUser(applied.target_id, "vote.update", dto);
  }
  return dto;
}

export function startVoteSweeper() {
  setInterval(async () => {
    try {
      const due = await q<{ id: string }>(`select id from votes where status = 'open' and expires_at <= now()`);
      for (const { id } of due) {
        const v = await fetchVote(id);
        if (v && v.status === "open") await resolve(id, v.yes >= v.requiredVotes ? "passed" : "failed");
      }
    } catch (e) {
      console.error("vote sweeper failed", e);
    }
  }, 3000).unref();
}

export const voteRouter = Router();

voteRouter.post(
  "/servers/:serverId/votes",
  h(async (req, res) => {
    const user = req.user!;
    rateLimit(`vote:${user.id}`, 5, 60_000);
    const { targetId } = z.object({ targetId: z.string().uuid() }).parse(req.body);
    res.json({ vote: await startVote(req.params.serverId, user.id, targetId) });
  })
);

voteRouter.post(
  "/votes/:voteId/ballot",
  h(async (req, res) => {
    const { choice } = z.object({ choice: z.boolean() }).parse(req.body);
    res.json({ vote: await castBallot(req.params.voteId, req.user!.id, choice) });
  })
);
