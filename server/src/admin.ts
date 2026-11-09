import { Router } from "express";
import { z } from "zod";
import { one, q, tx } from "./db";
import { channelSlug } from "./fileutil";
import { HttpError, h } from "./http";
import { isHuddleAdmin, membership, requireMember, requirePerm, type Permission } from "./perms";
import { emitServer, emitUser, leaveServerRooms } from "./realtime";
import { CHANNEL_PERMS } from "./channelperms";

export const adminRouter = Router();

const modSchema = z.object({
  targetId: z.string().uuid(),
  action: z.enum(["kick", "ban", "timeout", "untimeout", "unban"]),
  durationSeconds: z.number().int().min(60).max(365 * 86400).nullish(), // ban: null = permanent
  reason: z.string().trim().max(200).optional(),
});

/** Instant moderation without a vote. Needs the matching permission, and only works on people ranked below you (the owner outranks everyone). */
adminRouter.post("/servers/:serverId/moderation", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  const actor = await requireMember(serverId, user.id);
  const { targetId, action, durationSeconds, reason } = modSchema.parse(req.body);
  const needed: Permission = action === "kick" ? "kick_members" : action === "timeout" || action === "untimeout" ? "timeout_members" : "ban_members";
  if (!actor.perms.has(needed)) throw new HttpError(403, "You don't have permission to do that.");
  if (targetId === user.id) throw new HttpError(400, "You can't moderate yourself.");
  const detail = JSON.stringify({ reason: reason || undefined, durationSeconds: durationSeconds ?? undefined });
  const audit = (c: any, name: string) =>
    q(`insert into audit_log(server_id, actor_id, target_id, action, detail) values ($1, $2, $3, $4, $5)`, [serverId, user.id, targetId, name, detail], c);

  if (action === "unban") {
    const removed = await q(`delete from server_bans where server_id = $1 and user_id = $2 returning 1`, [serverId, targetId]);
    if (!removed.length) throw new HttpError(404, "That person isn't banned.");
    await audit(undefined, "mod.unban");
    return void res.json({ ok: true });
  }

  const target = await membership(serverId, targetId);
  if (!target) throw new HttpError(404, "That person isn't in this server.");
  if (target.role === "owner") throw new HttpError(403, "The owner can't be moderated.");
  if (await isHuddleAdmin(targetId)) throw new HttpError(403, "You can't moderate this person.");
  if (target.top >= actor.top) throw new HttpError(403, "You can only moderate people whose roles are ranked below yours.");

  if (action === "timeout") {
    if (!durationSeconds || durationSeconds > 28 * 86400) throw new HttpError(400, "Pick a timeout length of up to 28 days.");
    await tx(async (c) => {
      await q(
        `insert into server_timeouts(server_id, user_id, until) values ($1, $2, now() + make_interval(secs => $3))
         on conflict (server_id, user_id) do update set until = excluded.until`,
        [serverId, targetId, durationSeconds],
        c
      );
      await audit(c, "mod.timeout");
    });
    emitServer(serverId, "member.update", { serverId, userId: targetId });
  } else if (action === "untimeout") {
    await q(`delete from server_timeouts where server_id = $1 and user_id = $2`, [serverId, targetId]);
    await audit(undefined, "mod.untimeout");
    emitServer(serverId, "member.update", { serverId, userId: targetId });
  } else {
    await tx(async (c) => {
      if (action === "ban")
        await q(
          `insert into server_bans(server_id, user_id, until)
           values ($1, $2, case when $3::float8 is null then 'infinity'::timestamptz else now() + make_interval(secs => $3::float8) end)
           on conflict (server_id, user_id) do update set until = excluded.until`,
          [serverId, targetId, durationSeconds ?? null],
          c
        );
      await q(`delete from memberships where server_id = $1 and user_id = $2`, [serverId, targetId], c);
      await audit(c, action === "ban" ? "mod.ban" : "mod.kick");
    });
    leaveServerRooms(targetId, serverId);
    emitUser(targetId, "server.removed", { serverId, reason: action, source: "admin" });
    emitServer(serverId, "member.leave", { serverId, userId: targetId });
  }
  res.json({ ok: true });
}));

adminRouter.get("/servers/:serverId/bans", h(async (req, res) => {
  await requirePerm(req.params.serverId, req.user!.id, "ban_members");
  const rows = await q<any>(
    `select b.user_id, u.username, coalesce(u.display_name, u.username) as name, (b.until = 'infinity') as permanent,
            case when b.until = 'infinity' then null else b.until end as until
       from server_bans b join users u on u.id = b.user_id where b.server_id = $1 and b.until > now() order by u.username`,
    [req.params.serverId]
  );
  res.json({ bans: rows.map((r) => ({ userId: r.user_id, username: r.username, name: r.name, permanent: r.permanent, until: r.until ? new Date(r.until).toISOString() : null })) });
}));

// ---------- channels ----------
adminRouter.delete("/servers/:serverId/channels/:channelId", h(async (req, res) => {
  const { serverId, channelId } = req.params;
  await requirePerm(serverId, req.user!.id, "manage_channels");
  const count = await one<{ n: number }>(`select count(*)::int as n from channels where server_id = $1`, [serverId]);
  if (count!.n <= 1) throw new HttpError(400, "A server needs at least one channel.");
  const ch = await one<{ name: string }>(`delete from channels where id = $1 and server_id = $2 returning name`, [channelId, serverId]);
  if (!ch) throw new HttpError(404, "Channel not found.");
  await q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, 'channel.delete', $3)`, [serverId, req.user!.id, JSON.stringify({ name: ch.name })]);
  emitServer(serverId, "channel.delete", { serverId, channelId });
  res.json({ ok: true });
}));

adminRouter.patch("/servers/:serverId/channels/:channelId", h(async (req, res) => {
  const { serverId, channelId } = req.params;
  await requirePerm(serverId, req.user!.id, "manage_channels");
  const name = channelSlug(z.object({ name: z.string().trim().min(1).max(30) }).parse(req.body).name);
  if (!name) throw new HttpError(400, "Channel names need letters or numbers.");
  const before = await one<{ name: string }>(`select name from channels where id = $1 and server_id = $2`, [channelId, serverId]);
  const ch = await one(`update channels set name = $3 where id = $1 and server_id = $2 returning id, name`, [channelId, serverId, name]);
  if (!ch) throw new HttpError(404, "Channel not found.");
  if (before && before.name !== name) await q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, 'channel.rename', $3)`, [serverId, req.user!.id, JSON.stringify({ from: before.name, to: name })]);
  emitServer(serverId, "channel.update", { serverId });
  res.json({ channel: ch });
}));

// ---------- channel permissions (needs manage channels) ----------
/** What each role (and "everyone", roleId null) is explicitly allowed or denied in this channel. Anything not listed is inherited. */
adminRouter.get("/servers/:serverId/channels/:channelId/permissions", h(async (req, res) => {
  const { serverId, channelId } = req.params;
  await requirePerm(serverId, req.user!.id, "manage_channels");
  const ch = await one(`select 1 from channels where id = $1 and server_id = $2`, [channelId, serverId]);
  if (!ch) throw new HttpError(404, "Channel not found.");
  const rows = await q<any>(`select role_id, allow, deny from channel_overrides where channel_id = $1`, [channelId]);
  res.json({ permissions: CHANNEL_PERMS, overrides: rows.map((r) => ({ roleId: (r.role_id ?? null) as string | null, allow: r.allow as string[], deny: r.deny as string[] })) });
}));

const overridesSchema = z.object({
  overrides: z
    .array(z.object({ roleId: z.string().uuid().nullable(), allow: z.array(z.enum(CHANNEL_PERMS)).max(CHANNEL_PERMS.length), deny: z.array(z.enum(CHANNEL_PERMS)).max(CHANNEL_PERMS.length) }))
    .max(60),
});

/** Replaces the channel's overrides with exactly the ones sent. */
adminRouter.put("/servers/:serverId/channels/:channelId/permissions", h(async (req, res) => {
  const { serverId, channelId } = req.params;
  const user = req.user!;
  await requirePerm(serverId, user.id, "manage_channels");
  const ch = await one<{ name: string }>(`select name from channels where id = $1 and server_id = $2`, [channelId, serverId]);
  if (!ch) throw new HttpError(404, "Channel not found.");
  const { overrides } = overridesSchema.parse(req.body);
  const seen = new Set<string | null>();
  const keep: { roleId: string | null; allow: string[]; deny: string[] }[] = [];
  for (const o of overrides) {
    if (seen.has(o.roleId)) throw new HttpError(400, "Each role can only be listed once.");
    seen.add(o.roleId);
    const allow = [...new Set(o.allow)], deny = [...new Set(o.deny)];
    if (allow.some((p) => deny.includes(p))) throw new HttpError(400, "A permission can't be both allowed and denied for the same role.");
    if (allow.length || deny.length) keep.push({ roleId: o.roleId, allow, deny });
  }
  const roleIds = keep.map((o) => o.roleId).filter((r): r is string => !!r);
  if (roleIds.length) {
    const found = await q(`select id from server_roles where server_id = $1 and id = any($2::uuid[])`, [serverId, roleIds]);
    if (found.length !== roleIds.length) throw new HttpError(400, "One of those roles doesn't exist in this server.");
  }
  await tx(async (c) => {
    await q(`delete from channel_overrides where channel_id = $1`, [channelId], c);
    for (const o of keep) await q(`insert into channel_overrides(channel_id, role_id, allow, deny) values ($1, $2, $3::text[], $4::text[])`, [channelId, o.roleId, o.allow, o.deny], c);
  });
  await q(`insert into audit_log(server_id, actor_id, action, detail) values ($1, $2, 'channel.permissions', $3)`, [serverId, user.id, JSON.stringify({ name: ch.name })]);
  emitServer(serverId, "channel.update", { serverId });
  res.json({ ok: true });
}));

// ---------- deleted messages (needs manage messages) ----------
adminRouter.get("/servers/:serverId/deleted", h(async (req, res) => {
  await requirePerm(req.params.serverId, req.user!.id, "manage_messages");
  const rows = await q<any>(
    `select d.id::text as id, d.channel_name, d.content, d.gif_url, d.created_at, d.attachments, d.meta, d.deleted_at, d.author_id, d.deleted_by,
            coalesce(a.display_name, a.username) as author_name, coalesce(b.display_name, b.username) as deleted_by_name
       from deleted_messages d join users a on a.id = d.author_id join users b on b.id = d.deleted_by
      where d.server_id = $1 order by d.deleted_at desc limit 100`,
    [req.params.serverId]
  );
  res.json({
    messages: rows.map((r) => ({
      id: r.id,
      channelName: r.channel_name,
      content: r.content,
      gif: r.gif_url,
      createdAt: new Date(r.created_at).toISOString(),
      deletedAt: new Date(r.deleted_at).toISOString(),
      attachments: r.attachments,
      poll: r.meta?.poll ?? null,
      authorId: r.author_id,
      authorName: r.author_name,
      deletedById: r.deleted_by,
      deletedByName: r.deleted_by_name,
    })),
  });
}));
