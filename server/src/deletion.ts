import { Router } from "express";
import { verify } from "@node-rs/argon2";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { assertNotDm, requireMember } from "./perms";
import { requireSecondFactor } from "./security";
import { closeServerRoom, dropUser, emitServer } from "./realtime";

/**
 * Deleting servers and accounts.
 *
 * A deleted server takes everything in it with it (channels, messages, files, invites, bans, history); the database
 * cascades from the server row. A deleted account is erased rather than removed: the row stays as an empty
 * placeholder named "Deleted user" so that other people's conversations and message history keep making sense, but
 * everything personal is gone (name, picture, bio, password, sessions, memberships, blocks, invites, uploads), and the
 * username becomes free to register again. Optionally the person's messages, reactions and poll votes go too.
 */
export const deletionRouter = Router();

export async function deleteServer(serverId: string) {
  await q(`delete from servers where id = $1`, [serverId]);
  emitServer(serverId, "server.removed", { serverId, reason: "deleted" });
  closeServerRoom(serverId);
}

export async function eraseAccount(userId: string, opts: { deleteMessages: boolean }) {
  const touched = await q<{ server_id: string; is_dm: boolean }>(
    `select m.server_id, s.is_dm from memberships m join servers s on s.id = m.server_id where m.user_id = $1`,
    [userId]
  );
  let removed: { id: string; channel_id: string; server_id: string }[] = [];
  await tx(async (c) => {
    await q(`delete from sessions where user_id = $1`, [userId], c);
    // Direct-message memberships stay so the other person's conversation (with a "Deleted user") isn't lost.
    await q(`delete from memberships m using servers s where m.user_id = $1 and s.id = m.server_id and not s.is_dm`, [userId], c);
    await q(`delete from server_timeouts where user_id = $1`, [userId], c);
    await q(`delete from server_bans where user_id = $1`, [userId], c);
    await q(`delete from user_blocks where blocker = $1 or blocked = $1`, [userId], c);
    await q(`delete from user_avatars where user_id = $1`, [userId], c);
    await q(`delete from suggestion_votes where user_id = $1`, [userId], c);
    await q(`delete from email_codes where user_id = $1`, [userId], c);
    await q(`delete from recovery_codes where user_id = $1`, [userId], c);
    await q(`delete from invites where created_by = $1`, [userId], c);
    await q(`delete from votes where status = 'open' and (target_id = $1 or initiator_id = $1)`, [userId], c);
    await q(`delete from attachments where uploader_id = $1 and message_id is null`, [userId], c);
    if (opts.deleteMessages) {
      removed = await q(
        `delete from messages m using channels c where m.author_id = $1 and c.id = m.channel_id returning m.id::text as id, m.channel_id, c.server_id`,
        [userId],
        c
      );
      await q(`delete from reactions where user_id = $1`, [userId], c);
      await q(`delete from poll_votes where user_id = $1`, [userId], c);
      await q(`delete from deleted_messages where author_id = $1`, [userId], c);
      await q(`delete from suggestions where author_id = $1`, [userId], c);
    }
    await q(
      `update users set username = 'deleted_' || substr(replace(id::text, '-', ''), 1, 12), display_name = 'Deleted user', bio = '',
              accent = null, status_text = '', avatar_version = 0, password_hash = '!', huddle_admin = false, huddle_admin_locked = false,
              banned_until = null, ban_reason = null, deleted_at = now(),
              email = null, email_verified_at = null, totp_secret = null, totp_pending = null, totp_enabled_at = null, totp_last_step = null
        where id = $1`,
      [userId],
      c
    );
  });

  for (const t of touched) {
    if (t.is_dm) emitServer(t.server_id, "profile.update", { serverId: t.server_id, userId });
    else emitServer(t.server_id, "member.leave", { serverId: t.server_id, userId });
  }
  for (const r of removed.slice(0, 1000)) emitServer(r.server_id, "message.delete", { serverId: r.server_id, channelId: r.channel_id, messageId: r.id });
  dropUser(userId, "account.removed", { reason: "deleted" });
}

deletionRouter.delete("/servers/:serverId", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  rateLimit(`delserver:${user.id}`, 10, 3600_000);
  const m = await requireMember(serverId, user.id);
  await assertNotDm(serverId);
  if (m.role !== "owner") throw new HttpError(403, "Only the owner can delete a server.");
  const { name } = z.object({ name: z.string() }).parse(req.body);
  const server = await one<{ name: string }>(`select name from servers where id = $1`, [serverId]);
  if (!server) throw new HttpError(404, "Server not found.");
  if (name.trim() !== server.name) throw new HttpError(400, "Type the server's name exactly to confirm.");
  await deleteServer(serverId);
  res.json({ ok: true });
}));

/** Delete your own account. Needs your password, and you can't still own servers (delete them first). */
deletionRouter.delete("/me", h(async (req, res) => {
  const user = req.user!;
  rateLimit(`delaccount:${user.id}`, 5, 3600_000);
  const { password, deleteMessages, code } = z.object({ password: z.string().max(128), deleteMessages: z.boolean().default(false), code: z.string().max(40).optional() }).parse(req.body);
  const row = await one<{ password_hash: string }>(`select password_hash from users where id = $1`, [user.id]);
  const ok = row ? await verify(row.password_hash, password).catch(() => false) : false;
  if (!ok) throw new HttpError(403, "That password isn't right.");
  await requireSecondFactor(user.id, code);
  const owned = await q<{ name: string }>(`select name from servers where owner_id = $1 and not is_dm order by name`, [user.id]);
  if (owned.length)
    throw new HttpError(409, `You still own ${owned.length === 1 ? "a server" : `${owned.length} servers`} (${owned.map((s) => s.name).join(", ")}). Delete ${owned.length === 1 ? "it" : "them"} first.`);
  await eraseAccount(user.id, { deleteMessages });
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
}));
