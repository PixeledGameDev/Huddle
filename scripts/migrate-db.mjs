#!/usr/bin/env node
/**
 * Copies a whole Huddle database (accounts, servers, messages, avatars, uploaded files, everything) to another Postgres.
 *
 *   node scripts/migrate-db.mjs --from "<old connection string>" --to "<new connection string>"
 *
 * Needs the Postgres command-line tools (pg_dump, pg_restore, psql) on this computer, version 16 or newer if your old
 * database is Postgres 16. No tools? See "Moving to a new database" in the README for the Docker version.
 * Your connection strings can also come from SOURCE_DATABASE_URL and TARGET_DATABASE_URL.
 *
 * It refuses to touch a target that already has Huddle tables (add --force to wipe and replace them), never changes the
 * source, and finishes by comparing row counts table by table.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const source = opt("from") ?? process.env.SOURCE_DATABASE_URL;
const target = opt("to") ?? process.env.TARGET_DATABASE_URL;
const keepDump = opt("keep-dump");
const force = flag("force");
const yes = flag("yes");

if (flag("help") || !source || !target) {
  console.log(`Usage: node scripts/migrate-db.mjs --from <old url> --to <new url> [--force] [--yes] [--keep-dump file.dump]

  --force        replace Huddle tables that already exist in the new database
  --yes          don't ask for confirmation
  --keep-dump    also save the dump file here (a handy backup)`);
  process.exit(flag("help") ? 0 : 1);
}

/** Splits a postgres:// URL so the password goes in the environment instead of on the command line. */
function connection(raw, label) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    fail(`The ${label} connection string isn't a valid URL. It should look like postgres://user:password@host:5432/dbname`);
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) fail(`The ${label} connection string must start with postgres:// or postgresql://`);
  const env = { PGPASSWORD: decodeURIComponent(u.password) };
  const safe = new URL(u);
  safe.password = "";
  return {
    url: safe.toString(),
    env,
    label: `${u.username ? u.username + "@" : ""}${u.host}${u.pathname}`,
    id: `${u.host}${u.pathname}`,
  };
}
function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}
function run(cmd, cmdArgs, conn, { quiet = false } = {}) {
  const r = spawnSync(cmd, cmdArgs, { env: { ...process.env, ...conn?.env }, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  if (r.error?.code === "ENOENT") fail(`${cmd} isn't installed (or isn't on your PATH). Install the PostgreSQL command-line tools, or use the Docker method in the README.`);
  if (r.status !== 0) {
    if (!quiet) console.error(r.stderr || r.stdout);
    return { ok: false, out: r.stdout, err: r.stderr };
  }
  return { ok: true, out: r.stdout.trim(), err: r.stderr };
}
const psql = (conn, sql) => run("psql", [conn.url, "-X", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql], conn, { quiet: true });

const src = connection(source, "source");
const dst = connection(target, "target");
if (src.id === dst.id) fail("The source and the target are the same database.");

console.log(`\nHuddle database migration\n  from: ${src.label}\n    to: ${dst.label}\n`);

// ---- checks
for (const tool of ["pg_dump", "pg_restore", "psql"]) {
  const v = run(tool, ["--version"], null, { quiet: true });
  if (!v.ok) fail(`${tool} isn't installed (or isn't on your PATH). Install the PostgreSQL command-line tools, or use the Docker method in the README.`);
}
const srcVer = psql(src, "show server_version_num");
if (!srcVer.ok) fail(`Couldn't connect to the source database.\n${srcVer.err}\nIf it's on Render or another host, make sure the URL is the *external* one and ends with ?sslmode=require`);
const dstVer = psql(dst, "show server_version_num");
if (!dstVer.ok) fail(`Couldn't connect to the target database.\n${dstVer.err}\nMake sure the URL is correct and ends with ?sslmode=require if the host needs SSL.`);
const major = (n) => Math.floor(Number(n) / 10000);
const dumpVer = (run("pg_dump", ["--version"], null).out.match(/(\d+)(?:\.\d+)?/) ?? [])[1];
if (Number(dumpVer) < major(srcVer.out)) fail(`Your pg_dump is version ${dumpVer} but the source database is version ${major(srcVer.out)}. Install pg_dump ${major(srcVer.out)} or newer.`);
if (major(dstVer.out) < major(srcVer.out)) fail(`The target is Postgres ${major(dstVer.out)} but the source is ${major(srcVer.out)}. Pick a target that's ${major(srcVer.out)} or newer.`);

const tablesQuery = "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1";
const srcTables = psql(src, tablesQuery).out.split("\n").filter(Boolean);
if (!srcTables.includes("users")) fail("The source doesn't look like a Huddle database (there's no users table).");
const dstTables = psql(dst, tablesQuery).out.split("\n").filter(Boolean);
if (dstTables.length && !force) {
  fail(`The target already has tables (${dstTables.slice(0, 4).join(", ")}${dstTables.length > 4 ? ", …" : ""}). Point --to at an empty database, or add --force to wipe and replace them.`);
}
const sizeRow = psql(src, "select pg_size_pretty(pg_database_size(current_database()))");
console.log(`Source: Postgres ${major(srcVer.out)}, ${srcTables.length} tables, ${sizeRow.out} on disk.`);
console.log(`Target: Postgres ${major(dstVer.out)}, ${dstTables.length ? `${dstTables.length} existing tables (will be replaced)` : "empty"}.\n`);
console.log("⚠  Messages sent after the dump starts won't be copied. Stop your Huddle server first (suspend the Render web service) so nothing changes during the move.\n");

if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Type MIGRATE to continue: ")).trim();
  rl.close();
  if (answer !== "MIGRATE") fail("Cancelled. Nothing was changed.");
}

// ---- dump and restore
const dumpFile = keepDump ? path.resolve(keepDump) : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "huddle-migrate-")), "huddle.dump");
console.log("\n1/3 Dumping the source database…");
const dump = run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpFile, src.url], src);
if (!dump.ok) fail("The dump failed (see above). Nothing was changed.");
console.log(`    saved ${(fs.statSync(dumpFile).size / 1024 / 1024).toFixed(1)} MB${keepDump ? ` to ${dumpFile}` : ""}`);

console.log("2/3 Restoring into the target…");
const restoreArgs = ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", dst.url];
if (dstTables.length) restoreArgs.unshift("--clean", "--if-exists");
restoreArgs.push(dumpFile);
const restore = run("pg_restore", restoreArgs, dst);
if (!restore.ok) fail("The restore failed (see above). Your source database is untouched; fix the problem and run this again with --force.");

// ---- verify
console.log("3/3 Checking every table…");
let bad = 0;
const width = Math.max(...srcTables.map((t) => t.length));
for (const t of srcTables) {
  const a = psql(src, `select count(*) from "${t}"`).out;
  const b = psql(dst, `select count(*) from "${t}"`).out;
  const same = a === b;
  if (!same) bad++;
  console.log(`    ${same ? "✔" : "✖"} ${t.padEnd(width)}  ${a.padStart(8)} → ${b.padStart(8)}`);
}
if (!keepDump) fs.rmSync(path.dirname(dumpFile), { recursive: true, force: true });
if (bad) fail(`${bad} table(s) don't match. Don't switch over; run again with --force, or ask for help.`);

console.log(`
✔ Done: every table matches.

Next:
  1. Set DATABASE_URL on your Huddle web service to the new connection string.
  2. If the new host needs SSL (Neon, Supabase and most hosted databases do), also set DATABASE_SSL=true.
  3. Start the service, open the site, and check your servers and messages are all there.
  4. Keep the old database for a few days as a backup, then delete it.
`);
