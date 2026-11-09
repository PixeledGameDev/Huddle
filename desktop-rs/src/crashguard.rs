//! When Huddle's page crashes the app reloads it. That should fix a one-off crash, but a page that crashes again and again
//! must not be reloaded forever: after `max` crashes within `window` it stops and lets the person know.
// Not connected yet: the web view library doesn't report when the page's process dies (see README, "Known gaps"). The logic is
// finished and tested so that wiring it up later is one call.
#![allow(dead_code)]
use std::time::{Duration, Instant};

pub struct CrashGuard {
    max: usize,
    window: Duration,
    times: Vec<Instant>,
}

impl CrashGuard {
    pub fn new(max: usize, window: Duration) -> Self {
        CrashGuard { max, window, times: Vec::new() }
    }
    pub fn standard() -> Self {
        Self::new(3, Duration::from_secs(5 * 60))
    }
    /// Records a crash at `now`. Returns true if reloading is still fine, false once there have been too many.
    pub fn allow_reload_at(&mut self, now: Instant) -> bool {
        let window = self.window;
        self.times.retain(|t| now.duration_since(*t) < window);
        self.times.push(now);
        self.times.len() <= self.max
    }
    pub fn allow_reload(&mut self) -> bool {
        self.allow_reload_at(Instant::now())
    }
}

/// Which ways the page's process can end are worth a reload ("clean-exit" is a normal shutdown).
pub fn should_reload(reason: &str) -> bool {
    reason != "clean-exit"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_few_crashes_are_reloaded_a_crash_loop_is_not() {
        let mut g = CrashGuard::new(3, Duration::from_secs(300));
        let t = Instant::now();
        let r: Vec<bool> = (0..4).map(|_| g.allow_reload_at(t)).collect();
        assert_eq!(r, [true, true, true, false]);
    }
    #[test]
    fn crashes_spread_out_over_time_never_add_up_to_a_loop() {
        let mut g = CrashGuard::new(3, Duration::from_secs(300));
        let t0 = Instant::now();
        for i in 1..=10u64 {
            assert!(g.allow_reload_at(t0 + Duration::from_secs(360 * i)));
        }
    }
    #[test]
    fn after_a_quiet_spell_it_is_allowed_again() {
        let mut g = CrashGuard::new(2, Duration::from_secs(60));
        let t = Instant::now();
        g.allow_reload_at(t);
        g.allow_reload_at(t);
        assert!(!g.allow_reload_at(t));
        assert!(g.allow_reload_at(t + Duration::from_secs(61)));
    }
    #[test]
    fn only_a_normal_shutdown_is_left_alone() {
        assert!(!should_reload("clean-exit"));
        for r in ["crashed", "oom", "abnormal-exit", "killed", "launch-failed", "integrity-failure"] {
            assert!(should_reload(r), "{r}");
        }
    }
}
