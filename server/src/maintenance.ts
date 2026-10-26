import type { NextFunction, Request, Response, Router as ExpressRouter } from "express";
import { Router } from "express";
import { userFromCookie } from "./auth";
import { one, q } from "./db";
import { h } from "./http";
import { isHuddleAdmin } from "./perms";
import { broadcastMaintenance } from "./realtime";

/**
 * Maintenance mode: a Huddle Admin sets how long Huddle will be down. Until the timer runs out (or an admin ends it
 * early) everyone else gets a maintenance screen with a countdown and the API refuses them. Huddle Admins can still
 * sign in and use everything, so they can finish the work and turn it off.
 *
 * The state is kept in memory for speed and mirrored to the database so a restart doesn't end it early.
 */
export interface Maintenance { active: boolean; endsAt: string | null; startedAt: string | null; message: string | null }
const OFF: Maintenance = { active: false, endsAt: null, startedAt: null, message: null };

let current: { endsAt: number; startedAt: number; message: string | null } | null = null;

export function maintenanceState(): Maintenance {
  if (!current || current.endsAt <= Date.now()) return OFF;
  return { active: true, endsAt: new Date(current.endsAt).toISOString(), startedAt: new Date(current.startedAt).toISOString(), message: current.message };
}
export const inMaintenance = () => maintenanceState().active;

export async function loadMaintenance() {
  const row = await one<{ value: { endsAt: number; startedAt: number; message: string | null } }>(`select value from site_state where key = 'maintenance'`);
  current = row && row.value.endsAt > Date.now() ? row.value : null;
  if (current) console.log(`Maintenance mode is on until ${new Date(current.endsAt).toISOString()}`);
}

/** Starts (or changes) maintenance for the given number of minutes from now. */
export async function startMaintenance(minutes: number, message: string | null) {
  const now = Date.now();
  current = { endsAt: now + minutes * 60_000, startedAt: current && current.endsAt > now ? current.startedAt : now, message };
  await q(
    `insert into site_state(key, value) values ('maintenance', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(current)]
  );
  await broadcastMaintenance(maintenanceState());
  return maintenanceState();
}

export async function endMaintenance() {
  current = null;
  await q(`delete from site_state where key = 'maintenance'`);
  await broadcastMaintenance(OFF);
}

/** The timer running out ends maintenance by itself. */
export function startMaintenanceWatcher() {
  setInterval(() => {
    if (current && current.endsAt <= Date.now()) endMaintenance().catch(console.error);
  }, 2000).unref();
}

export const maintenanceRouter: ExpressRouter = Router();
// Public: the maintenance screen (and the sign-in page) need this before anyone is signed in.
maintenanceRouter.get("/maintenance", h(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ...maintenanceState(), now: new Date().toISOString() });
}));

/** While maintenance is on, only Huddle Admins get through. Sign-in stays open so an admin can get in. */
export async function maintenanceGate(req: Request, res: Response, next: NextFunction) {
  try {
    const m = maintenanceState();
    if (!m.active) return next();
    if (req.path === "/maintenance" || req.path.startsWith("/auth/")) return next();
    const user = await userFromCookie(req.headers.cookie);
    if (user && (await isHuddleAdmin(user.id))) return next();
    res.set("Retry-After", "60");
    res.status(503).json({ error: "Huddle is down for maintenance.", maintenance: m });
  } catch (e) {
    next(e);
  }
}
