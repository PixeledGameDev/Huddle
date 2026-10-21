import { Readable } from "stream";
import { AwsClient } from "aws4fetch";
import { one, q } from "./db";

/**
 * File storage on Cloudflare R2 (S3-compatible). Enabled when all of these are set:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * Without them, files stay in Postgres, so local development needs no extra setup.
 * R2_ENDPOINT can override the endpoint (used for testing against a local S3 server).
 */
const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT } = process.env;

export const r2Enabled = !!(R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && (R2_ACCOUNT_ID || R2_ENDPOINT));

const base = (R2_ENDPOINT ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/$/, "");
const aws = r2Enabled
  ? new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID!, secretAccessKey: R2_SECRET_ACCESS_KEY!, service: "s3", region: "auto", retries: 3 })
  : null;

const urlFor = (key: string) => `${base}/${R2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;

async function fail(action: string, r: Response): Promise<never> {
  const body = await r.text().catch(() => "");
  throw new Error(`R2 ${action} failed: ${r.status} ${body.slice(0, 300)}`);
}

export async function putObject(key: string, body: Buffer, contentType: string) {
  const r = await aws!.fetch(urlFor(key), { method: "PUT", body: body as unknown as BodyInit, headers: { "Content-Type": contentType } });
  if (!r.ok) await fail("upload", r);
}

/** Returns the upstream response so callers can stream it to the client. */
export async function getObject(key: string, headers?: Record<string, string>) {
  return aws!.fetch(urlFor(key), headers ? { headers } : undefined);
}

export async function deleteObject(key: string) {
  const r = await aws!.fetch(urlFor(key), { method: "DELETE" });
  if (!r.ok && r.status !== 404) await fail("delete", r);
}

export const toNodeStream = (body: ReadableStream<Uint8Array>) => Readable.fromWeb(body as any);

/** Logs whether the bucket is reachable and the credentials work. */
export async function checkR2() {
  try {
    const r = await aws!.fetch(`${base}/${R2_BUCKET}`, { method: "HEAD" });
    if (r.ok) console.log(`R2 storage enabled (bucket "${R2_BUCKET}")`);
    else console.error(`R2 storage is configured but the bucket check failed with HTTP ${r.status}. Check the credentials, token permissions, and bucket name.`);
  } catch (e) {
    console.error("R2 storage is configured but unreachable:", e);
  }
}

/** Moves files that were stored in Postgres (before R2 was enabled) into R2. Safe to run repeatedly. */
export async function migrateLegacyFiles() {
  let moved = 0;
  try {
    for (;;) {
      const rows = await q<{ id: string; mime: string; data: Buffer }>(
        `select id, mime, data from attachments where storage_key is null and data is not null order by created_at limit 5`
      );
      if (!rows.length) break;
      for (const r of rows) {
        const key = `files/${r.id}`;
        await putObject(key, r.data, r.mime);
        await q(`update attachments set storage_key = $2, data = null where id = $1 and storage_key is null`, [r.id, key]);
        moved++;
      }
    }
    if (moved) console.log(`Moved ${moved} existing file(s) from Postgres to R2.`);
  } catch (e) {
    console.error(`Moving existing files to R2 stopped after ${moved} file(s); it will resume on the next start.`, e);
  }
}

/**
 * Deleting a message, channel, or stale upload removes its attachment row; a database trigger queues the object
 * key in storage_deletions, and this sweeper removes the objects from R2.
 */
export function startStorageSweeper(intervalMs = Number(process.env.STORAGE_SWEEP_MS ?? 60_000)) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await q<{ key: string }>(`select key from storage_deletions order by created_at limit 50`);
      for (const { key } of rows) {
        await deleteObject(key);
        await q(`delete from storage_deletions where key = $1`, [key]);
      }
    } catch (e) {
      console.error("storage cleanup failed", e);
    } finally {
      running = false;
    }
  };
  setInterval(sweep, intervalMs).unref();
  void sweep();
}

export async function pendingDeletions() {
  return (await one<{ n: number }>(`select count(*)::int as n from storage_deletions`))!.n;
}
