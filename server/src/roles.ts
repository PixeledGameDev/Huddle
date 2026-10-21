import { Router } from "express";
import type { PoolClient } from "pg";
import { z } from "zod";
import { one, q, tx } from "./db";
import { HttpError, h, rateLimit } from "./http";
import { PERMISSIONS, assertNotDm, membership, requireMember, requirePerm, type Access, type Permission } from "./perms";
import { emitServer } from "./realtime";

export const rolesRouter = Router();

const MAX_ROLES = 25;

const roleBody = z.object({
  name: z.string().trim().min(1, "Give the role a name.").max(32),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a valid color.").nullable().default(null),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

interface RoleRow { id: string; name: string; color: string | null; permissions: string[]; position: number }

async function loadRole(serverId: string, roleId: string): Promise<RoleRow> {
  const r = await one<RoleRow>(`select id, name, color, permissions, position from server_roles where id = $1 and server_id = $2`, [roleId, serverId]);
  if (!r) throw new HttpError(404, "Role not found.");
  return r;
}

/** You can only touch roles ranked below your own highest role (the owner outranks every role). */
function assertOutranks(actor: Access, position: number) {
  if (actor.top <= position) throw new HttpError(403, "That role is ranked at or above your highest role.");
}
/** You can only hand out permissions you hold yourself. */
function assertGrantable(actor: Access, perms: readonly Permission[]) {
  const missing = perms.find((p) => !actor.perms.has(p));
  if (missing) throw new HttpError(403, "You can't give a permission you don't have yourself.");
}

const audit = (c: PoolClient | undefined, serverId: string, actorId: string, targetId: string | null, action: string, detail: object) =>
  q(`insert into audit_log(server_id, actor_id, target_id, action, detail) values ($1, $2, $3, $4, $5)`, [serverId, actorId, targetId, action, JSON.stringify(detail)], c);

/** Inserts a role at the bottom of the list (everything else moves up one). */
async function insertRole(c: PoolClient, serverId: string, body: z.infer<typeof roleBody>) {
  const n = await one<{ n: number }>(`select count(*)::int as n from server_roles where server_id = $1`, [serverId], c);
  if (n!.n >= MAX_ROLES) throw new HttpError(400, `A server can have at most ${MAX_ROLES} roles.`);
  await q(`update server_roles set position = position + 1 where server_id = $1`, [serverId], c);
  return (await one<RoleRow>(
    `insert into server_roles(server_id, name, color, permissions, position) values ($1, $2, $3, $4::text[], 1) returning id, name, color, permissions, position`,
    [serverId, body.name, body.color, body.permissions],
    c
  ))!;
}

rolesRouter.post("/servers/:serverId/roles", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  const actor = await requirePerm(serverId, user.id, "manage_roles");
  await assertNotDm(serverId);
  rateLimit(`role:${user.id}`, 30, 60_000);
  const body = roleBody.parse(req.body);
  assertGrantable(actor, body.permissions);
  const role = await tx(async (c) => {
    const r = await insertRole(c, serverId, body);
    await audit(c, serverId, user.id, null, "role.create", { name: r.name, permissions: r.permissions });
    return r;
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ role });
}));

rolesRouter.patch("/servers/:serverId/roles/:roleId", h(async (req, res) => {
  const { serverId, roleId } = req.params;
  const user = req.user!;
  const actor = await requirePerm(serverId, user.id, "manage_roles");
  rateLimit(`role:${user.id}`, 30, 60_000);
  const body = roleBody.partial().parse(req.body);
  const role = await loadRole(serverId, roleId);
  assertOutranks(actor, role.position);
  if (body.permissions) assertGrantable(actor, body.permissions.filter((p) => !role.permissions.includes(p)));
  const next = { name: body.name ?? role.name, color: body.color === undefined ? role.color : body.color, permissions: body.permissions ?? role.permissions };
  await tx(async (c) => {
    await q(`update server_roles set name = $3, color = $4, permissions = $5::text[] where id = $1 and server_id = $2`, [roleId, serverId, next.name, next.color, next.permissions], c);
    await audit(c, serverId, user.id, null, "role.update", {
      name: next.name,
      renamedFrom: next.name !== role.name ? role.name : undefined,
      added: next.permissions.filter((p) => !role.permissions.includes(p)),
      removed: role.permissions.filter((p) => !next.permissions.includes(p)),
    });
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

rolesRouter.post("/servers/:serverId/roles/:roleId/move", h(async (req, res) => {
  const { serverId, roleId } = req.params;
  const user = req.user!;
  const actor = await requirePerm(serverId, user.id, "manage_roles");
  const { direction } = z.object({ direction: z.enum(["up", "down"]) }).parse(req.body);
  await tx(async (c) => {
    const roles = await q<RoleRow>(`select id, name, color, permissions, position from server_roles where server_id = $1 order by position desc for update`, [serverId], c);
    const i = roles.findIndex((r) => r.id === roleId);
    if (i < 0) throw new HttpError(404, "Role not found.");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= roles.length) return;
    assertOutranks(actor, roles[i].position);
    assertOutranks(actor, roles[j].position);
    await q(`update server_roles set position = case when id = $2::uuid then $4::int else $3::int end where server_id = $1 and id in ($2, $5)`, [serverId, roles[i].id, roles[i].position, roles[j].position, roles[j].id], c);
    await audit(c, serverId, user.id, null, "role.reorder", { name: roles[i].name, direction });
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

rolesRouter.delete("/servers/:serverId/roles/:roleId", h(async (req, res) => {
  const { serverId, roleId } = req.params;
  const user = req.user!;
  const actor = await requirePerm(serverId, user.id, "manage_roles");
  const role = await loadRole(serverId, roleId);
  assertOutranks(actor, role.position);
  await tx(async (c) => {
    await q(`delete from server_roles where id = $1`, [roleId], c);
    await audit(c, serverId, user.id, null, "role.delete", { name: role.name });
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ ok: true });
}));

async function changeAssignment(req: any, res: any, give: boolean) {
  const { serverId, userId, roleId } = req.params as Record<string, string>;
  const user = req.user!;
  const actor = await requirePerm(serverId, user.id, "manage_roles");
  const role = await loadRole(serverId, roleId);
  assertOutranks(actor, role.position);
  const target = await membership(serverId, userId);
  if (!target) throw new HttpError(404, "That person isn't in this server.");
  if (target.role === "owner") throw new HttpError(400, "The owner already has every permission.");
  if (userId !== user.id && target.top >= actor.top) throw new HttpError(403, "You can only change roles for people ranked below you.");
  const real = await one(`select 1 from memberships where server_id = $1 and user_id = $2`, [serverId, userId]);
  if (!real) throw new HttpError(404, "That person isn't in this server.");
  const changed = give
    ? await q(`insert into member_roles(server_id, user_id, role_id) values ($1, $2, $3) on conflict do nothing returning 1`, [serverId, userId, roleId])
    : await q(`delete from member_roles where server_id = $1 and user_id = $2 and role_id = $3 returning 1`, [serverId, userId, roleId]);
  if (changed.length) {
    await audit(undefined, serverId, user.id, userId, give ? "role.assign" : "role.unassign", { name: role.name });
    emitServer(serverId, "server.update", { serverId });
  }
  res.json({ ok: true });
}

rolesRouter.put("/servers/:serverId/members/:userId/roles/:roleId", h((req, res) => changeAssignment(req, res, true)));
rolesRouter.delete("/servers/:serverId/members/:userId/roles/:roleId", h((req, res) => changeAssignment(req, res, false)));

/**
 * Servers that existed before roles had a single "admin" rank. The owner either turns those admins into a real role
 * (they keep their access, now as ordinary role permissions) or removes the admin rank without a replacement.
 */
rolesRouter.post("/servers/:serverId/legacy-admins", h(async (req, res) => {
  const { serverId } = req.params;
  const user = req.user!;
  const me = await requireMember(serverId, user.id);
  if (me.role !== "owner") throw new HttpError(403, "Only the owner can do that.");
  const body = z.object({ mode: z.enum(["role", "demote"]), role: roleBody.optional() }).parse(req.body);
  if (body.mode === "role" && !body.role) throw new HttpError(400, "Describe the role to create.");
  const converted = await tx(async (c) => {
    const admins = await q<{ user_id: string }>(`select user_id from memberships where server_id = $1 and role = 'admin' for update`, [serverId], c);
    if (!admins.length) return 0;
    let roleName: string | null = null;
    if (body.mode === "role") {
      const role = await insertRole(c, serverId, body.role!);
      roleName = role.name;
      await q(`insert into member_roles(server_id, user_id, role_id) select $1, user_id, $2 from memberships where server_id = $1 and role = 'admin' on conflict do nothing`, [serverId, role.id], c);
    }
    await q(`update memberships set role = 'member' where server_id = $1 and role = 'admin'`, [serverId], c);
    await audit(c, serverId, user.id, null, "role.legacy", { mode: body.mode, count: admins.length, name: roleName });
    return admins.length;
  });
  emitServer(serverId, "server.update", { serverId });
  res.json({ converted });
}));
