import { one, q } from "./db";

export interface PollDto {
  id: string;
  question: string;
  multi: boolean;
  anonymous: boolean;
  endsAt: string | null;
  closed: boolean;
  options: { id: string; text: string; count: number; voterIds: string[] }[];
  myVotes: string[];
  totalVoters: number;
}

/** Polls with live tallies. voterIds are omitted for anonymous polls. viewerId = null gives the broadcast shape. */
export async function pollDtos(pollIds: string[], viewerId: string | null): Promise<Map<string, PollDto>> {
  const out = new Map<string, PollDto>();
  if (!pollIds.length) return out;
  const polls = await q<any>(`select id, question, multi, anonymous, ends_at, closed_at from polls where id = any($1::uuid[])`, [pollIds]);
  const opts = await q<any>(
    `select o.id, o.poll_id, o.text, count(v.user_id)::int as count
       from poll_options o left join poll_votes v on v.option_id = o.id
      where o.poll_id = any($1::uuid[]) group by o.id order by o.position`,
    [pollIds]
  );
  const voters = await q<any>(
    `select v.option_id, array_agg(v.user_id order by v.created_at) as user_ids
       from poll_votes v join polls p on p.id = v.poll_id
      where v.poll_id = any($1::uuid[]) and not p.anonymous group by v.option_id`,
    [pollIds]
  );
  const totals = await q<any>(`select poll_id, count(distinct user_id)::int as n from poll_votes where poll_id = any($1::uuid[]) group by poll_id`, [pollIds]);
  const mine = viewerId ? await q<any>(`select poll_id, option_id from poll_votes where poll_id = any($1::uuid[]) and user_id = $2`, [pollIds, viewerId]) : [];
  for (const p of polls) {
    out.set(p.id, {
      id: p.id,
      question: p.question,
      multi: p.multi,
      anonymous: p.anonymous,
      endsAt: p.ends_at ? new Date(p.ends_at).toISOString() : null,
      closed: !!p.closed_at || (!!p.ends_at && new Date(p.ends_at) <= new Date()),
      options: opts.filter((o) => o.poll_id === p.id).map((o) => ({ id: o.id, text: o.text, count: o.count, voterIds: voters.find((v) => v.option_id === o.id)?.user_ids ?? [] })),
      myVotes: mine.filter((m) => m.poll_id === p.id).map((m) => m.option_id),
      totalVoters: totals.find((t) => t.poll_id === p.id)?.n ?? 0,
    });
  }
  return out;
}

export const messageSelect = `select m.id::text as id, m.channel_id, c.server_id, m.author_id,
         coalesce(u.display_name, u.username) as author_name, u.avatar_version as author_avatar,
         m.content, m.created_at, m.edited_at, m.reply_to::text as reply_to, m.mentions, m.mentions_everyone, m.gif_url, m.status_reply, m.sticker_id::text as sticker_id,
         (select name from server_stickers st where st.id = m.sticker_id) as sticker_name
    from messages m join users u on u.id = m.author_id join channels c on c.id = m.channel_id`;

/** Attach files, reactions, reply previews, and polls to a batch of message rows (a fixed number of queries). */
export async function hydrate(rows: any[], viewerId: string | null) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))] as string[];
  const [atts, reacts, pollRows, replies] = await Promise.all([
    q<any>(`select id, message_id::text as message_id, name, mime, size from attachments where message_id = any($1::bigint[]) order by created_at, id`, [ids]),
    q<any>(
      `select message_id::text as message_id, emoji, array_agg(user_id order by created_at) as user_ids
         from reactions where message_id = any($1::bigint[]) group by message_id, emoji order by min(created_at)`,
      [ids]
    ),
    q<any>(`select id, message_id::text as message_id from polls where message_id = any($1::bigint[])`, [ids]),
    replyIds.length
      ? q<any>(
          `select m.id::text as id, m.author_id, coalesce(u.display_name, u.username) as author_name, left(m.content, 120) as snippet,
                  (m.gif_url is not null or exists(select 1 from attachments a where a.message_id = m.id) or exists(select 1 from polls p where p.message_id = m.id)) as has_extra
             from messages m join users u on u.id = m.author_id where m.id = any($1::bigint[])`,
          [replyIds]
        )
      : Promise.resolve([] as any[]),
  ]);
  const polls = await pollDtos(pollRows.map((p) => p.id), viewerId);
  return rows.map((r) => {
    const reply = r.reply_to ? replies.find((x) => x.id === r.reply_to) : null;
    const pollId = pollRows.find((p) => p.message_id === r.id)?.id;
    return {
      id: r.id as string,
      channelId: r.channel_id as string,
      serverId: r.server_id as string,
      authorId: r.author_id as string,
      authorName: r.author_name as string,
      authorAvatar: r.author_avatar as number,
      content: r.content as string,
      createdAt: new Date(r.created_at).toISOString(),
      editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
      mentions: (r.mentions ?? []) as string[],
      mentionsEveryone: !!r.mentions_everyone,
      gif: (r.gif_url ?? null) as string | null,
      sticker: r.sticker_id ? { id: r.sticker_id as string, name: r.sticker_name as string } : null,
      statusReply: (r.status_reply ?? null) as string | null,
      replyTo: reply ? { id: reply.id as string, authorId: reply.author_id as string, authorName: reply.author_name as string, snippet: reply.snippet as string, hasExtra: !!reply.has_extra } : null,
      attachments: atts.filter((a) => a.message_id === r.id).map((a) => ({ id: a.id as string, name: a.name as string, mime: a.mime as string, size: a.size as number })),
      reactions: reacts.filter((x) => x.message_id === r.id).map((x) => ({ emoji: x.emoji as string, userIds: x.user_ids as string[] })),
      poll: pollId ? polls.get(pollId) ?? null : null,
    };
  });
}
export type MessageDto = Awaited<ReturnType<typeof hydrate>>[number];

export async function getMessageDto(messageId: string, viewerId: string | null): Promise<MessageDto | null> {
  const rows = await q(`${messageSelect} where m.id = $1::bigint`, [messageId]);
  return (await hydrate(rows, viewerId))[0] ?? null;
}

export async function messageExists(id: string) {
  return !!(await one(`select 1 from messages where id = $1::bigint`, [id]));
}
