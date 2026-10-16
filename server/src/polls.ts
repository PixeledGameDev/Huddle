import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { getMessageDto, pollDtos } from "./hydrate";
import { HttpError, h, rateLimit } from "./http";
import { assertCanWrite, channelServer, requireMember } from "./perms";
import { emitServer } from "./realtime";

export const pollsRouter = Router();

const createSchema = z.object({
  question: z.string().trim().min(1, "Add a question.").max(200),
  options: z.array(z.string().trim().min(1, "Options can't be empty.").max(80)).min(2, "A poll needs at least 2 options.").max(10, "A poll can have at most 10 options."),
  multi: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  durationSeconds: z.number().int().min(60).max(7 * 86400).nullish(),
});

pollsRouter.post("/channels/:channelId/polls", h(async (req, res) => {
  const user = req.user!;
  const { channelId } = req.params;
  const serverId = await channelServer(channelId);
  await requireMember(serverId, user.id);
  await assertCanWrite(serverId, user.id);
  rateLimit(`poll:${user.id}`, 5, 60_000);
  const body = createSchema.parse(req.body);
  if (new Set(body.options.map((o) => o.toLowerCase())).size !== body.options.length) throw new HttpError(400, "Poll options must be different from each other.");
  const messageId = await tx(async (c) => {
    const m = await one<{ id: string }>(`insert into messages(channel_id, author_id, content) values ($1, $2, '') returning id::text as id`, [channelId, user.id], c);
    const poll = await one<{ id: string }>(
      `insert into polls(message_id, question, multi, anonymous, ends_at)
       values ($1::bigint, $2, $3, $4, case when $5::float8 is null then null else now() + make_interval(secs => $5::float8) end) returning id`,
      [m!.id, body.question, body.multi, body.anonymous, body.durationSeconds ?? null],
      c
    );
    for (let i = 0; i < body.options.length; i++) await q(`insert into poll_options(poll_id, text, position) values ($1, $2, $3)`, [poll!.id, body.options[i], i], c);
    return m!.id;
  });
  const message = await getMessageDto(messageId, null);
  emitServer(serverId, "message.create", message);
  res.json({ message });
}));

async function pollContext(pollId: string) {
  const p = await one<any>(
    `select p.id, p.multi, p.closed_at, p.ends_at, p.message_id::text as message_id, m.author_id, m.channel_id, c.server_id
       from polls p join messages m on m.id = p.message_id join channels c on c.id = m.channel_id where p.id = $1`,
    [pollId]
  );
  if (!p) throw new HttpError(404, "Poll not found.");
  return p;
}
const isClosed = (p: any) => !!p.closed_at || (!!p.ends_at && new Date(p.ends_at) <= new Date());

async function broadcast(p: any) {
  const poll = (await pollDtos([p.id], null)).get(p.id)!;
  emitServer(p.server_id, "poll.update", { serverId: p.server_id, channelId: p.channel_id, messageId: p.message_id, poll });
}

pollsRouter.put("/polls/:pollId/vote", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`pollvote:${user.id}`, 30, 10_000);
  const p = await pollContext(req.params.pollId);
  await requireMember(p.server_id, user.id);
  await assertCanWrite(p.server_id, user.id);
  if (isClosed(p)) throw new HttpError(409, "This poll is closed.");
  const { optionIds } = z.object({ optionIds: z.array(z.string().uuid()).max(10) }).parse(req.body);
  const chosen = [...new Set(optionIds)];
  if (!p.multi && chosen.length > 1) throw new HttpError(400, "This poll only allows one choice.");
  if (chosen.length) {
    const valid = await q(`select id from poll_options where poll_id = $1 and id = any($2::uuid[])`, [p.id, chosen]);
    if (valid.length !== chosen.length) throw new HttpError(400, "That option isn't part of this poll.");
  }
  await tx(async (c) => {
    await q(`delete from poll_votes where poll_id = $1 and user_id = $2`, [p.id, user.id], c);
    for (const optionId of chosen) await q(`insert into poll_votes(poll_id, option_id, user_id) values ($1, $2, $3)`, [p.id, optionId, user.id], c);
  });
  await broadcast(p);
  res.json({ poll: (await pollDtos([p.id], user.id)).get(p.id) });
}));

pollsRouter.post("/polls/:pollId/close", h(async (req, res) => {
  const user = req.user!;
  const p = await pollContext(req.params.pollId);
  const me = await requireMember(p.server_id, user.id);
  if (p.author_id !== user.id && me.role === "member") throw new HttpError(403, "Only the poll's author or an admin can close it.");
  if (isClosed(p)) throw new HttpError(409, "This poll is already closed.");
  await q(`update polls set closed_at = now() where id = $1`, [p.id]);
  await broadcast(p);
  res.json({ poll: (await pollDtos([p.id], user.id)).get(p.id) });
}));
