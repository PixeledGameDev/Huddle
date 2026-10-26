import { Router } from "express";
import { z } from "zod";
import { one, q } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { isHuddleAdmin } from "./perms";

/**
 * Suggestions: a site-wide board where anyone can propose an improvement to Huddle and vote on other people's ideas.
 * Huddle Admins decide what happens to them (open → planned → in progress → done, or declined) and can remove any.
 */
export const suggestionsRouter = Router();

export const STATUSES = ["open", "planned", "in_progress", "done", "declined"] as const;
const CLOSED = ["done", "declined"];

const idParam = z.string().uuid();

async function present(id: string, viewerId: string) {
  return one<any>(
    `select s.id, s.title, s.body, s.status, s.created_at, s.author_id,
            coalesce(u.display_name, u.username) as author,
            (select count(*)::int from suggestion_votes v where v.suggestion_id = s.id) as votes,
            exists (select 1 from suggestion_votes v where v.suggestion_id = s.id and v.user_id = $2) as voted
       from suggestions s join users u on u.id = s.author_id where s.id = $1`,
    [id, viewerId]
  );
}

const shape = (r: any, viewerId: string) => ({
  id: r.id as string,
  title: r.title as string,
  body: r.body as string,
  status: r.status as string,
  author: r.author as string,
  mine: r.author_id === viewerId,
  votes: r.votes as number,
  voted: r.voted as boolean,
  createdAt: new Date(r.created_at).toISOString(),
});

suggestionsRouter.get("/suggestions", h(async (req, res) => {
  const viewer = req.user!.id;
  const closed = req.query.tab === "closed";
  const sort = req.query.sort === "new" ? "new" : "top";
  const rows = await q<any>(
    `select s.id, s.title, s.body, s.status, s.created_at, s.author_id,
            coalesce(u.display_name, u.username) as author,
            (select count(*)::int from suggestion_votes v where v.suggestion_id = s.id) as votes,
            exists (select 1 from suggestion_votes v where v.suggestion_id = s.id and v.user_id = $1) as voted
       from suggestions s join users u on u.id = s.author_id
      where (s.status = any($2::text[])) = $3
      order by ${sort === "new" ? "s.created_at desc" : "votes desc, s.created_at desc"}
      limit 200`,
    [viewer, CLOSED, closed]
  );
  res.json({ suggestions: rows.map((r) => shape(r, viewer)) });
}));

suggestionsRouter.post("/suggestions", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`suggest:${user.id}`, 5, 3600_000);
  const body = z
    .object({
      title: z.string().trim().min(3, "Give your suggestion a short title.").max(100, "Keep the title under 100 characters."),
      body: z.string().trim().max(1000, "Details can be up to 1000 characters.").default(""),
    })
    .parse(req.body);
  const row = await one<{ id: string }>(`insert into suggestions(author_id, title, body) values ($1, $2, $3) returning id`, [user.id, body.title, body.body]);
  await q(`insert into suggestion_votes(suggestion_id, user_id) values ($1, $2)`, [row!.id, user.id]); // you back your own idea
  res.json({ suggestion: shape(await present(row!.id, user.id), user.id) });
}));

/** Adds or removes your vote. Safe to repeat: the end result is the same. */
async function setVote(req: any, res: any, on: boolean) {
  const user = req.user!;
  rateLimit(`suggestvote:${user.id}`, 60, 60_000);
  const id = idParam.parse(req.params.id);
  if (!(await one(`select 1 from suggestions where id = $1`, [id]))) throw new HttpError(404, "That suggestion is gone.");
  if (on) await q(`insert into suggestion_votes(suggestion_id, user_id) values ($1, $2) on conflict do nothing`, [id, user.id]);
  else await q(`delete from suggestion_votes where suggestion_id = $1 and user_id = $2`, [id, user.id]);
  const r = await present(id, user.id);
  res.json({ votes: r.votes, voted: r.voted });
}
suggestionsRouter.put("/suggestions/:id/vote", h((req, res) => setVote(req, res, true)));
suggestionsRouter.delete("/suggestions/:id/vote", h((req, res) => setVote(req, res, false)));

/** Huddle Admins only: say what's happening with an idea. Everyone else is told it doesn't exist. */
suggestionsRouter.patch("/suggestions/:id", h(async (req, res) => {
  const user = req.user!;
  if (!(await isHuddleAdmin(user.id))) throw new HttpError(404, "Not found.");
  const id = idParam.parse(req.params.id);
  const { status } = z.object({ status: z.enum(STATUSES) }).parse(req.body);
  const done = await q(`update suggestions set status = $2, updated_at = now() where id = $1 returning id`, [id, status]);
  if (!done.length) throw new HttpError(404, "That suggestion is gone.");
  res.json({ suggestion: shape(await present(id, user.id), user.id) });
}));

/** The person who wrote it, or a Huddle Admin, can remove a suggestion. */
suggestionsRouter.delete("/suggestions/:id", h(async (req, res) => {
  const user = req.user!;
  const id = idParam.parse(req.params.id);
  const s = await one<{ author_id: string }>(`select author_id from suggestions where id = $1`, [id]);
  if (!s) throw new HttpError(404, "That suggestion is gone.");
  if (s.author_id !== user.id && !(await isHuddleAdmin(user.id))) throw new HttpError(403, "You can only remove your own suggestions.");
  await q(`delete from suggestions where id = $1`, [id]);
  res.json({ ok: true });
}));
