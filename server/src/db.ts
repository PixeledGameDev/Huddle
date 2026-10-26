import { AsyncLocalStorage } from "async_hooks";
import { Pool, PoolClient } from "pg";
import { SCHEMA } from "./schema";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX ?? 20),
  // Keep connections open between bursts. Opening a new one to a remote database costs a TLS handshake and a login
  // (hundreds of milliseconds), and the default of 10 idle seconds meant most requests after a pause paid it.
  idleTimeoutMillis: 10 * 60_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});
pool.on("error", (e) => console.error("idle database connection error", e.message)); // a dropped idle connection must not crash the server

/** Per-request tally of database work, so slow requests can say where the time went. */
export const requestStats = new AsyncLocalStorage<{ queries: number; ms: number }>();
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 300);

type Runner = Pool | PoolClient;

export async function q<T = any>(text: string, params: any[] = [], c: Runner = pool): Promise<T[]> {
  const t0 = performance.now();
  const r = await c.query(text, params);
  const ms = performance.now() - t0;
  const st = requestStats.getStore();
  if (st) { st.queries++; st.ms += ms; }
  if (ms > SLOW_QUERY_MS) console.warn(`slow query ${Math.round(ms)}ms: ${text.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  return r.rows as T[];
}

export async function one<T = any>(text: string, params: any[] = [], c: Runner = pool): Promise<T | null> {
  const rows = await q<T>(text, params, c);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const result = await fn(c);
    await c.query("commit");
    return result;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function migrate() {
  await pool.query(SCHEMA);
}

/**
 * Keeps a few connections warm so the first message after a quiet spell isn't slow, and says how far away the database is.
 * (A round trip of more than ~30ms means every extra query in a request is noticeable.)
 */
export function startPoolWarmer() {
  const ping = async () => {
    const t0 = performance.now();
    await Promise.all([1, 2, 3, 4].map(() => pool.query("select 1")));
    return performance.now() - t0;
  };
  ping().then((ms) => console.log(`Database round trip: ~${Math.round(ms)}ms`), () => {});
  setInterval(() => ping().catch(() => {}), 20_000).unref();
}
