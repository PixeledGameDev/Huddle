/**
 * A small log file for the desktop app: errors, crashes and a few milestones, kept in the app's data folder so there is
 * something to look at (and to send to whoever is helping) when something goes wrong.
 *
 * The file is `huddle.log`; when it gets big it becomes `huddle.1.log` (and so on) and a fresh one starts, so the logs
 * never grow without limit. Nothing here ever throws: if the disk is full or read-only, logging just stops.
 * Messages are never logged, only the app's own events and errors.
 */
const fs = require("node:fs");
const path = require("node:path");
const util = require("node:util");

const MAX_LINE = 4000;

/** Hides what should never end up in a log or in something pasted for help: secrets, cookies and URL query strings. */
function redact(text) {
  return String(text)
    .replace(/\b(authorization)(["']?\s*[=:]\s*)[^\n]+/gi, "$1$2[hidden]")
    .replace(/\b(token|password|passwd|secret|cookie|authorization|session)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1$2[hidden]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [hidden]")
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/gi, "$1?…");
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  if (typeof a === "string") return a;
  return util.inspect(a, { depth: 3, breakLength: Infinity, maxStringLength: 500, maxArrayLength: 20 });
}

/** One log line: "2026-10-30T09:15:02.123Z ERROR something happened". */
function formatLine(date, level, args) {
  let text = redact(args.map(formatArg).join(" ")).replace(/\r?\n(?!\s)/g, "\n    ");
  if (text.length > MAX_LINE) text = `${text.slice(0, MAX_LINE)}… (cut)`;
  return `${date.toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`;
}

/**
 * `dir` is the folder for the log files. `echo` also prints to the console (handy when running from source).
 * `fsImpl` and `now` are there so tests don't touch the real disk or clock.
 */
function createLogger({ dir, maxBytes = 512 * 1024, keep = 2, echo = false, fsImpl = fs, now = () => new Date() }) {
  const file = path.join(dir, "huddle.log");
  const rotated = (n) => path.join(dir, `huddle.${n}.log`);
  let size = null;
  let broken = false;

  function ensure() {
    if (size !== null) return;
    fsImpl.mkdirSync(dir, { recursive: true });
    try {
      size = fsImpl.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  function rotate() {
    for (let n = keep; n >= 1; n--) {
      try {
        if (n === keep) fsImpl.rmSync(rotated(n), { force: true });
        else fsImpl.renameSync(rotated(n), rotated(n + 1));
      } catch { /* that one doesn't exist yet */ }
    }
    try { fsImpl.renameSync(file, rotated(1)); } catch { /* nothing to move */ }
    size = 0;
  }
  function write(level, args) {
    const line = formatLine(now(), level, args);
    if (echo) (level === "info" ? console.log : console.error)(line.trimEnd());
    if (broken) return;
    try {
      ensure();
      if (size > 0 && size + line.length > maxBytes) rotate();
      fsImpl.appendFileSync(file, line);
      size += line.length;
    } catch {
      broken = true; // can't write here (full or read-only disk): give up quietly rather than fail on every message
    }
  }

  /** The last `count` entries of the current log (empty if there is none), for the "Copy debug info" text. An entry can span several lines. */
  function tail(count = 25) {
    try {
      const text = fsImpl.readFileSync(file, "utf8");
      const entries = text.slice(-16000).split(/\n(?=\d{4}-\d{2}-\d{2}T)/).map((e) => e.trimEnd()).filter(Boolean);
      if (text.length > 16000) entries.shift(); // the first one was cut in half
      return entries.slice(-count);
    } catch {
      return [];
    }
  }

  return {
    dir,
    file,
    tail,
    info: (...a) => write("info", a),
    warn: (...a) => write("warn", a),
    error: (...a) => write("error", a),
  };
}

module.exports = { createLogger, formatLine, redact };
