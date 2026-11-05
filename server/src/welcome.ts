import { one, q } from "./db";
import { botId, deliverDm } from "./huddleBot";

/**
 * Welcome messages: Huddle Admins write them, the Huddle bot sends them as direct messages.
 * Every new account gets all of them, oldest first. When one is added, everyone who already has an account gets it too.
 * welcome_deliveries remembers who was sent what, so a person never gets the same message twice
 * (for example when they sign up while a message is still going out to everyone).
 */
export const MAX_WELCOME_MESSAGES = 10;

export interface WelcomeMessage { id: string; content: string }

/** Sends one welcome message to one person unless they've had it. "skipped" means they blocked the bot. */
export async function deliverWelcome(bot: string, message: WelcomeMessage, userId: string): Promise<"sent" | "already" | "skipped"> {
  const claimed = await q(`insert into welcome_deliveries(message_id, user_id) values ($1::bigint, $2) on conflict do nothing returning 1`, [message.id, userId]);
  if (!claimed.length) return "already";
  try {
    if (await deliverDm(bot, userId, message.content)) return "sent";
    await q(`delete from welcome_deliveries where message_id = $1::bigint and user_id = $2`, [message.id, userId]);
    return "skipped";
  } catch (e) {
    await q(`delete from welcome_deliveries where message_id = $1::bigint and user_id = $2`, [message.id, userId]).catch(() => {});
    throw e;
  }
}

/** Called when an account is created. Never throws: signing up must not fail because a welcome message couldn't be sent. */
export async function sendWelcomeMessages(userId: string) {
  try {
    const messages = await q<WelcomeMessage>(`select id::text as id, content from welcome_messages order by id`);
    if (!messages.length) return;
    const bot = await botId();
    for (const m of messages) await deliverWelcome(bot, m, userId);
  } catch (e) {
    console.error("Couldn't send welcome messages", e);
  }
}

/** Everyone a newly added message goes out to: every real, active account. */
export async function welcomeRecipients(): Promise<string[]> {
  return (await q<{ id: string }>(`select id from users where not is_bot and deleted_at is null and (banned_until is null or banned_until <= now()) order by created_at`)).map((r) => r.id);
}

export async function welcomeMessageExists(id: string) {
  return !!(await one(`select 1 from welcome_messages where id = $1::bigint`, [id]));
}
