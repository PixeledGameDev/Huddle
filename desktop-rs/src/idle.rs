//! Away from the computer (port of desktop/src/idle.js): after a set time with no keyboard or mouse use (or while the screen
//! is locked or the computer sleeps) Huddle tells the server you're idle, and tells it again when you're back. The person's
//! own choice of status (Online, Do not disturb...) is never changed by this; the server only shows "Idle" when you're
//! otherwise Online. Reading the system is passed in, so this can be tested without a desktop.
use serde_json::Value;

pub const MINUTE_CHOICES: [u32; 5] = [5, 10, 15, 30, 60];
pub const DEFAULT_MINUTES: u32 = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdleSettings {
    pub enabled: bool,
    pub minutes: u32,
}

impl Default for IdleSettings {
    fn default() -> Self {
        IdleSettings { enabled: true, minutes: DEFAULT_MINUTES }
    }
}

pub fn sanitize_idle_settings(v: &Value, current: IdleSettings) -> IdleSettings {
    let minutes = v.get("minutes").and_then(Value::as_u64).map(|m| m as u32).filter(|m| MINUTE_CHOICES.contains(m));
    IdleSettings {
        enabled: v.get("enabled").and_then(Value::as_bool).unwrap_or(current.enabled),
        minutes: minutes.unwrap_or(if MINUTE_CHOICES.contains(&current.minutes) { current.minutes } else { DEFAULT_MINUTES }),
    }
}

pub struct IdleTracker {
    get_idle_seconds: Box<dyn Fn() -> f64 + Send>,
    on: bool,
    threshold_secs: f64,
    locked: bool, // the screen is locked or the computer is asleep
    idle: bool,
}

impl IdleTracker {
    pub fn new(settings: IdleSettings, get_idle_seconds: Box<dyn Fn() -> f64 + Send>) -> Self {
        IdleTracker { get_idle_seconds, on: settings.enabled, threshold_secs: settings.minutes as f64 * 60.0, locked: false, idle: false }
    }
    /// Looks at the situation now. Returns the new state if it changed. Called by the timer and by every event.
    pub fn check(&mut self) -> Option<bool> {
        let next = self.on && (self.locked || (self.get_idle_seconds)() >= self.threshold_secs);
        if next != self.idle {
            self.idle = next;
            return Some(next);
        }
        None
    }
    pub fn is_idle(&self) -> bool {
        self.idle
    }
    #[allow(dead_code)] // waiting for lock-screen / sleep notifications (see README, "Known gaps")
    pub fn set_locked(&mut self, v: bool) -> Option<bool> {
        self.locked = v;
        self.check()
    }
    pub fn configure(&mut self, s: IdleSettings) -> Option<bool> {
        self.on = s.enabled;
        if MINUTE_CHOICES.contains(&s.minutes) {
            self.threshold_secs = s.minutes as f64 * 60.0;
        }
        self.check()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{atomic::{AtomicU64, Ordering}, Arc};

    fn tracker(secs: Arc<AtomicU64>, s: IdleSettings) -> IdleTracker {
        IdleTracker::new(s, Box::new(move || secs.load(Ordering::SeqCst) as f64))
    }

    #[test]
    fn settings_are_cleaned() {
        let cur = IdleSettings::default();
        assert_eq!(sanitize_idle_settings(&json!({"enabled": false, "minutes": 30}), cur), IdleSettings { enabled: false, minutes: 30 });
        assert_eq!(sanitize_idle_settings(&json!({"minutes": 7}), cur), cur);
        assert_eq!(sanitize_idle_settings(&json!("junk"), cur), cur);
        assert_eq!(sanitize_idle_settings(&json!({}), IdleSettings { enabled: true, minutes: 99 }).minutes, DEFAULT_MINUTES);
    }
    #[test]
    fn going_idle_and_coming_back_is_reported_once_each() {
        let secs = Arc::new(AtomicU64::new(0));
        let mut t = tracker(secs.clone(), IdleSettings::default());
        assert_eq!(t.check(), None);
        secs.store(599, Ordering::SeqCst);
        assert_eq!(t.check(), None);
        secs.store(600, Ordering::SeqCst);
        assert_eq!(t.check(), Some(true));
        assert_eq!(t.check(), None);
        secs.store(1, Ordering::SeqCst);
        assert_eq!(t.check(), Some(false));
    }
    #[test]
    fn a_locked_screen_is_idle_straight_away() {
        let secs = Arc::new(AtomicU64::new(0));
        let mut t = tracker(secs, IdleSettings::default());
        assert_eq!(t.set_locked(true), Some(true));
        assert_eq!(t.set_locked(false), Some(false));
    }
    #[test]
    fn switched_off_never_goes_idle_and_settings_apply_at_once() {
        let secs = Arc::new(AtomicU64::new(10_000));
        let mut t = tracker(secs, IdleSettings { enabled: false, minutes: 5 });
        assert_eq!(t.check(), None);
        assert_eq!(t.set_locked(true), None);
        assert_eq!(t.configure(IdleSettings { enabled: true, minutes: 5 }), Some(true));
        assert_eq!(t.configure(IdleSettings { enabled: false, minutes: 5 }), Some(false));
    }
}
