import type http from "http";
import { Server as IOServer } from "socket.io";
import { userFromCookie } from "./auth";
import { one, q } from "./db";

let io: IOServer;
const online = new Map<string, Set<string>>(); // userId -> socket ids

export const isOnline = (userId: string) => online.has(userId);
export const onlineIds = () => [...online.keys()];

export const emitServer = (serverId: string, event: string, payload: unknown) =>
  io.to(`server:${serverId}`).emit(event, payload);
export const emitUser = (userId: string, event: string, payload: unknown) =>
  io.to(`user:${userId}`).emit(event, payload);
export const joinServerRooms = (userId: string, serverId: string) =>
  io.in(`user:${userId}`).socketsJoin(`server:${serverId}`);
export const leaveServerRooms = (userId: string, serverId: string) =>
  io.in(`user:${userId}`).socketsLeave(`server:${serverId}`);

/** The server is gone: everyone listening to it stops. */
export const closeServerRoom = (serverId: string) => io.in(`server:${serverId}`).socketsLeave(`server:${serverId}`);

/** Tells a person's open tabs something (optionally), then disconnects them. */
export function dropUser(userId: string, event?: string, payload?: unknown) {
  if (event) io.to(`user:${userId}`).emit(event, payload);
  io.in(`user:${userId}`).disconnectSockets(true);
}

/** Huddle Admins see live updates from every server, not just the ones they joined. */
export async function joinAllServers(userId: string) {
  const rows = await q<{ id: string }>(`select id from servers where not is_dm`);
  for (const r of rows) joinServerRooms(userId, r.id);
}
export async function leaveUnjoinedServers(userId: string) {
  const rows = await q<{ id: string }>(`select s.id from servers s where not exists (select 1 from memberships m where m.server_id = s.id and m.user_id = $1)`, [userId]);
  for (const r of rows) leaveServerRooms(userId, r.id);
}
/** A new server was just created: every Huddle Admin starts listening to it. */
export async function joinHuddleAdmins(serverId: string) {
  const rows = await q<{ id: string }>(`select id from users where huddle_admin`);
  for (const r of rows) joinServerRooms(r.id, serverId);
}

export function initRealtime(httpServer: http.Server) {
  io = new IOServer(httpServer, {
    cors: process.env.CLIENT_ORIGIN ? { origin: process.env.CLIENT_ORIGIN, credentials: true } : undefined,
  });

  io.use(async (socket, next) => {
    try {
      const user = await userFromCookie(socket.handshake.headers.cookie);
      if (!user) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    } catch (e) {
      next(e as Error);
    }
  });

  io.on("connection", async (socket) => {
    const user = socket.data.user as { id: string; username: string };
    try {
      const servers = await q<{ server_id: string }>(`select server_id from memberships where user_id = $1`, [user.id]);
      socket.join(`user:${user.id}`);
      for (const s of servers) socket.join(`server:${s.server_id}`);
      const extra = await q<{ id: string }>(
        `select s.id from servers s where not s.is_dm and exists (select 1 from users u where u.id = $1 and u.huddle_admin)`,
        [user.id]
      );
      for (const s of extra) socket.join(`server:${s.id}`);

      const set = online.get(user.id) ?? new Set<string>();
      const first = set.size === 0;
      set.add(socket.id);
      online.set(user.id, set);
      if (first) {
        for (const s of servers) emitServer(s.server_id, "presence", { serverId: s.server_id, userId: user.id, online: true });
      }
    } catch (e) {
      console.error("socket connect failed", e);
      socket.disconnect(true);
      return;
    }

    socket.on("typing", async (p: { channelId?: string }) => {
      try {
        if (typeof p?.channelId !== "string") return;
        const ch = await one<{ server_id: string }>(`select server_id from channels where id = $1`, [p.channelId]);
        if (!ch || !socket.rooms.has(`server:${ch.server_id}`)) return;
        socket.to(`server:${ch.server_id}`).emit("typing", { channelId: p.channelId, userId: user.id, username: user.username });
      } catch {
        /* ignore malformed ids */
      }
    });

    socket.on("disconnecting", () => {
      const rooms = [...socket.rooms].filter((r) => r.startsWith("server:"));
      const set = online.get(user.id);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(user.id);
        for (const r of rooms) {
          const serverId = r.slice("server:".length);
          emitServer(serverId, "presence", { serverId, userId: user.id, online: false });
        }
      }
    });
  });
}
