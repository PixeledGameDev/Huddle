//! Quiet hours (port of desktop/src/quiet.js): a daily window when Huddle stays silent. No popups, sounds or taskbar
//! flashing; unread counts and badges still update. The same rule lives in the website's notify code (web/src/quiet.ts).
use chrono::Timelike;
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;

static TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([01]\d|2[0-3]):([0-5]\d)$").unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quiet {
    pub enabled: bool,
    pub from: String,
    pub to: String,
}

impl Default for Quiet {
    fn default() -> Self {
        Quiet { enabled: false, from: "22:00".into(), to: "07:00".into() }
    }
}

impl Quiet {
    pub fn to_json(&self) -> Value {
        json!({ "enabled": self.enabled, "from": self.from, "to": self.to })
    }
}

/// Returns the schedule in its safe shape, whatever was passed in.
pub fn sanitize_quiet(q: &Value) -> Quiet {
    let ok = |key: &str, fallback: &str| match q.get(key).and_then(Value::as_str) {
        Some(t) if TIME.is_match(t) => t.to_string(),
        _ => fallback.to_string(),
    };
    Quiet { enabled: q.get("enabled") == Some(&Value::Bool(true)), from: ok("from", "22:00"), to: ok("to", "07:00") }
}

fn minutes_of(t: &str) -> u32 {
    let (h, m) = t.split_once(':').unwrap_or(("0", "0"));
    h.parse::<u32>().unwrap_or(0) * 60 + m.parse::<u32>().unwrap_or(0)
}

/// Is it quiet at `now_minutes` (minutes since local midnight)? A window that ends before it starts runs overnight;
/// equal times mean no window.
pub fn is_quiet_at(q: &Quiet, now_minutes: u32) -> bool {
    if !q.enabled {
        return false;
    }
    let (from, to) = (minutes_of(&q.from), minutes_of(&q.to));
    if from == to {
        return false;
    }
    if from < to { now_minutes >= from && now_minutes < to } else { now_minutes >= from || now_minutes < to }
}

pub fn is_quiet_now(q: &Quiet) -> bool {
    let now = chrono::Local::now();
    is_quiet_at(q, now.hour() * 60 + now.minute())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizing_gives_a_safe_shape() {
        assert_eq!(sanitize_quiet(&json!(null)), Quiet::default());
        assert_eq!(sanitize_quiet(&json!({"enabled": "yes", "from": "25:00", "to": "7:00"})), Quiet::default());
        assert_eq!(sanitize_quiet(&json!({"enabled": true, "from": "21:30", "to": "06:15"})), Quiet { enabled: true, from: "21:30".into(), to: "06:15".into() });
    }
    #[test]
    fn overnight_and_daytime_windows() {
        let night = Quiet { enabled: true, from: "22:00".into(), to: "07:00".into() };
        assert!(is_quiet_at(&night, 23 * 60));
        assert!(is_quiet_at(&night, 3 * 60));
        assert!(!is_quiet_at(&night, 7 * 60));
        assert!(!is_quiet_at(&night, 12 * 60));
        let day = Quiet { enabled: true, from: "09:00".into(), to: "17:00".into() };
        assert!(is_quiet_at(&day, 9 * 60));
        assert!(!is_quiet_at(&day, 17 * 60));
    }
    #[test]
    fn off_or_empty_windows_are_never_quiet() {
        assert!(!is_quiet_at(&Quiet::default(), 23 * 60));
        assert!(!is_quiet_at(&Quiet { enabled: true, from: "08:00".into(), to: "08:00".into() }, 8 * 60));
    }
}
