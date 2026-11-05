import { one, q, tx } from "./db";
import { dmList, revealDm } from "./dms";
import { getMessageDto } from "./hydrate";
import { HttpError } from "./http";
import { emitServer, emitUser, joinServerRooms } from "./realtime";

/** The built-in "Huddle" bot account: who speaks for the site in server channels and direct messages. Created by bootstrapHuddle(). */

export async function botId(): Promise<string> {
  const bot = await one<{ id: string }>(`select id from users where is_bot`);
  if (!bot) throw new HttpError(503, "The Huddle bot isn't available.");
  return bot.id;
}

/** Inserts a message written by the bot and returns its id. */
export async function insertBotMessage(channelId: string, bot: string, content: string, mentions: string[], everyone: boolean, c?: any) {
  const row = await one<{ id: string }>(
    `insert into messages(channel_id, author_id, content, mentions, mentions_everyone) values ($1, $2, $3, $4::uuid[], $5) returning id::text as id`,
    [channelId, bot, content, mentions, everyone],
    c
  );
  return row!.id;
}

/** Sends one DM from the bot, creating the conversation if there isn't one. Returns false if the person blocked the bot. */
export async function deliverDm(bot: string, userId: string, content: string): Promise<boolean> {
  if (await one(`select 1 from user_blocks where blocker = $1 and blocked = $2`, [userId, bot])) return false;
  const key = [bot, userId].sort().join(":");
  let created = false;
  const found = await one<{ id: string; channel_id: string }>(
    `select s.id, (select c.id from channels c where c.server_id = s.id order by c.created_at limit 1) as channel_id from servers s where s.dm_key = $1`,
    [key]
  );
  let serverId = found?.id;
  let channelId = found?.channel_id;
  if (!serverId || !channelId) {
    ({ serverId, channelId, created } = await tx(async (c) => {
      const s = await one<{ id: string }>(
        `insert into servers(name, owner_id, is_dm, dm_key) values ('', $1, true, $2) on conflict (dm_key) where dm_key is not null do nothing returning id`,
        [bot, key],
        c
      );
      if (!s) {
        const existing = (await one<{ id: string; channel_id: string }>(
          `select s.id, (select c.id from channels c where c.server_id = s.id order by c.created_at limit 1) as channel_id from servers s where s.dm_key = $1`,
          [key],
          c
        ))!;
        return { serverId: existing.id, channelId: existing.channel_id, created: false };
      }
      await q(`insert into memberships(server_id, user_id, role) values ($1, $2, 'member'), ($1, $3, 'member')`, [s.id, bot, userId], c);
      const ch = await one<{ id: string }>(`insert into channels(server_id, name) values ($1, 'chat') returning id`, [s.id], c);
      return { serverId: s.id, channelId: ch!.id, created: true };
    }));
  }
  const messageId = await insertBotMessage(channelId!, bot, content, [userId], false);
  joinServerRooms(userId, serverId!);
  if (created) emitUser(userId, "dm.new", (await dmList(userId, serverId))[0]);
  else await revealDm(serverId!);
  emitServer(serverId!, "message.create", await getMessageDto(messageId, null));
  return true;
}
