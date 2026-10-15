import { Pool, PoolClient } from "pg";
import { SCHEMA } from "./schema";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

type Runner = Pool | PoolClient;

export async function q<T = any>(text: string, params: any[] = [], c: Runner = pool): Promise<T[]> {
  const r = await c.query(text, params);
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
