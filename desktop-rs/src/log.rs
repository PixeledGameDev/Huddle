//! A small log file for the desktop app: errors, crashes and a few milestones, kept in the app's
//! data folder so there is something to look at when something goes wrong.
//!
//! The file is `huddle.log`; when it gets big it becomes `huddle.1.log` (and so on) and a fresh one starts, so the logs
//! never grow without limit. Nothing here ever fails loudly: if the disk is full or read-only, logging just stops.
//! Messages are never logged, only the app's own events and errors.
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};

const MAX_LINE: usize = 4000;

static RE_AUTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)\b(authorization)(["']?\s*[=:]\s*)[^\n]+"#).unwrap());
static RE_SECRET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)\b(token|password|passwd|secret|cookie|authorization|session)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)"#).unwrap());
static RE_BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+").unwrap());
static RE_QUERY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(https?://[^\s?#"']+)\?[^\s"']*"#).unwrap());
static RE_ENTRY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d{4}-\d{2}-\d{2}T").unwrap());

/// Hides what should never end up in a log or in something pasted for help: secrets, cookies and URL query strings.
pub fn redact(text: &str) -> String {
    let t = RE_AUTH.replace_all(text, "${1}${2}[hidden]");
    let t = RE_SECRET.replace_all(&t, "${1}${2}[hidden]");
    let t = RE_BEARER.replace_all(&t, "Bearer [hidden]");
    RE_QUERY.replace_all(&t, "${1}?…").into_owned()
}

/// One log line: "2026-10-30T09:15:02.123Z ERROR something happened".
pub fn format_line(date: DateTime<Utc>, level: &str, message: &str) -> String {
    let redacted = redact(message);
    let mut text = String::new();
    for (i, line) in redacted.replace("\r\n", "\n").split('\n').enumerate() {
        if i > 0 {
            text.push('\n');
            if !line.starts_with(char::is_whitespace) {
                text.push_str("    ");
            }
        }
        text.push_str(line);
    }
    if text.chars().count() > MAX_LINE {
        text = format!("{}… (cut)", text.chars().take(MAX_LINE).collect::<String>());
    }
    format!("{} {:<5} {}\n", date.to_rfc3339_opts(SecondsFormat::Millis, true), level.to_uppercase(), text)
}

struct Inner {
    size: Option<u64>,
    broken: bool,
}

pub struct Logger {
    pub dir: PathBuf,
    pub file: PathBuf,
    max_bytes: u64,
    keep: u32,
    echo: bool,
    inner: Mutex<Inner>,
}

impl Logger {
    pub fn new(dir: PathBuf, echo: bool) -> Self {
        Self::with_limits(dir, echo, 512 * 1024, 2)
    }
    pub fn with_limits(dir: PathBuf, echo: bool, max_bytes: u64, keep: u32) -> Self {
        let file = dir.join("huddle.log");
        Logger { dir, file, max_bytes, keep, echo, inner: Mutex::new(Inner { size: None, broken: false }) }
    }
    fn rotated(&self, n: u32) -> PathBuf {
        self.dir.join(format!("huddle.{n}.log"))
    }
    fn rotate(&self) {
        for n in (1..=self.keep).rev() {
            if n == self.keep {
                let _ = fs::remove_file(self.rotated(n));
            } else {
                let _ = fs::rename(self.rotated(n), self.rotated(n + 1));
            }
        }
        let _ = fs::rename(&self.file, self.rotated(1));
    }
    fn write(&self, level: &str, message: &str) {
        let line = format_line(Utc::now(), level, message);
        if self.echo {
            eprint!("{line}");
        }
        let Ok(mut inner) = self.inner.lock() else { return };
        if inner.broken {
            return;
        }
        let result = (|| -> std::io::Result<()> {
            if inner.size.is_none() {
                fs::create_dir_all(&self.dir)?;
                inner.size = Some(fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0));
            }
            let size = inner.size.unwrap_or(0);
            if size > 0 && size + line.len() as u64 > self.max_bytes {
                self.rotate();
                inner.size = Some(0);
            }
            OpenOptions::new().create(true).append(true).open(&self.file)?.write_all(line.as_bytes())?;
            inner.size = Some(inner.size.unwrap_or(0) + line.len() as u64);
            Ok(())
        })();
        if result.is_err() {
            inner.broken = true; // can't write here (full or read-only disk): give up quietly rather than fail on every message
        }
    }
    pub fn info(&self, m: impl AsRef<str>) { self.write("info", m.as_ref()) }
    pub fn warn(&self, m: impl AsRef<str>) { self.write("warn", m.as_ref()) }
    pub fn error(&self, m: impl AsRef<str>) { self.write("error", m.as_ref()) }

    /// The last `count` entries of the current log (empty if there is none), for the "Copy debug info" text.
    /// An entry can span several lines.
    pub fn tail(&self, count: usize) -> Vec<String> {
        let Ok(bytes) = fs::read(&self.file) else { return vec![] };
        let cut = bytes.len() > 16000;
        let start = bytes.len().saturating_sub(16000);
        let text = String::from_utf8_lossy(&bytes[start..]).into_owned();
        let mut entries: Vec<String> = Vec::new();
        for line in text.lines() {
            if RE_ENTRY.is_match(line) || entries.is_empty() {
                entries.push(line.to_string());
            } else if let Some(last) = entries.last_mut() {
                last.push('\n');
                last.push_str(line);
            }
        }
        if cut && !entries.is_empty() {
            entries.remove(0); // the first one was cut in half
        }
        let skip = entries.len().saturating_sub(count);
        entries.into_iter().skip(skip).map(|e| e.trim_end().to_string()).filter(|e| !e.is_empty()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("huddle-log-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn secrets_and_query_strings_are_hidden() {
        assert_eq!(redact("token=abc123 ok"), "token=[hidden] ok");
        assert_eq!(redact("Cookie: sid=xyz; other"), "Cookie: [hidden]; other");
        assert_eq!(redact("Authorization: Bearer abc.def"), "Authorization: [hidden]");
        assert_eq!(redact("got Bearer abc.def-ghi"), "got Bearer [hidden]");
        assert_eq!(redact("GET https://h.example/api/x?code=secret&y=1 failed"), "GET https://h.example/api/x?… failed");
        assert_eq!(redact("nothing to hide"), "nothing to hide");
    }
    #[test]
    fn lines_are_stamped_and_continuations_indented() {
        let t = chrono::DateTime::parse_from_rfc3339("2026-10-30T09:15:02.123Z").unwrap().with_timezone(&Utc);
        assert_eq!(format_line(t, "error", "boom\nat here\n  already indented"), "2026-10-30T09:15:02.123Z ERROR boom\n    at here\n  already indented\n");
        assert!(format_line(t, "info", &"x".repeat(5000)).contains("… (cut)"));
    }
    #[test]
    fn the_log_rolls_over_and_never_grows_without_limit() {
        let dir = tmp("rotate");
        let log = Logger::with_limits(dir.clone(), false, 300, 2);
        for i in 0..40 {
            log.info(format!("line number {i} with some padding to take space"));
        }
        assert!(dir.join("huddle.log").exists() && dir.join("huddle.1.log").exists() && dir.join("huddle.2.log").exists());
        assert!(!dir.join("huddle.3.log").exists());
        assert!(fs::metadata(dir.join("huddle.log")).unwrap().len() <= 300);
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn tail_returns_whole_entries() {
        let dir = tmp("tail");
        let log = Logger::new(dir.clone(), false);
        assert!(log.tail(5).is_empty());
        log.info("one");
        log.error("two\nsecond line");
        log.warn("three");
        let t = log.tail(2);
        assert_eq!(t.len(), 2);
        assert!(t[0].contains("ERROR two\n    second line") && t[1].ends_with("WARN  three"));
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn an_unwritable_folder_does_not_panic() {
        let file_in_the_way = std::env::temp_dir().join(format!("huddle-log-test-blocked-{}", std::process::id()));
        fs::write(&file_in_the_way, "x").unwrap();
        let log = Logger::new(file_in_the_way.join("sub"), false);
        log.error("nobody will see this");
        let _ = fs::remove_file(file_in_the_way);
    }
}
