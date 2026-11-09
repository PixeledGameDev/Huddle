//! Global shortcuts: keys that work from any program, even while Huddle is hidden in the tray.
//!
//! Three actions can have one: show or hide Huddle, open the quick switcher, jump to the next unread message.
//! They are off until the person sets them, because any combination might already be used by something else.
//!
//! A shortcut works everywhere, so one with no modifier (a plain "A") would stop that key working in every program.
//! Only combinations with Ctrl, Alt or the Windows key are accepted. Registering is a trait, so this runs without a desktop.
use global_hotkey::hotkey::{Code, HotKey, Modifiers};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::str::FromStr;

pub const ACTIONS: [&str; 3] = ["toggle", "switcher", "unread"];
const ORDER: [&str; 4] = ["Control", "Alt", "Shift", "Super"];
// The system keeps these for itself, so registering them fails or, worse, would be confusing.
const RESERVED: [&str; 8] = ["Control+Alt+Delete", "Alt+F4", "Alt+Tab", "Control+Escape", "Alt+Escape", "Super+L", "Super+D", "Super+Tab"];

fn modifier(token: &str) -> Option<&'static str> {
    Some(match token.to_lowercase().as_str() {
        "ctrl" | "control" => "Control",
        "alt" | "option" => "Alt",
        "shift" => "Shift",
        "super" | "win" | "windows" | "meta" | "cmd" | "command" => "Super",
        _ => return None,
    })
}

fn named_key(token: &str) -> Option<&'static str> {
    Some(match token.to_lowercase().as_str() {
        "space" => "Space", "tab" => "Tab", "backspace" => "Backspace", "delete" | "del" => "Delete", "insert" => "Insert",
        "return" | "enter" => "Return", "home" => "Home", "end" => "End", "pageup" => "PageUp", "pagedown" => "PageDown",
        "up" => "Up", "down" => "Down", "left" => "Left", "right" => "Right", "escape" | "esc" => "Escape",
        _ => return None,
    })
}

fn normalize_key(token: &str) -> Option<String> {
    let mut chars = token.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        if c.is_ascii_alphanumeric() {
            return Some(c.to_ascii_uppercase().to_string());
        }
    }
    let lower = token.to_lowercase();
    if let Some(n) = lower.strip_prefix('f').and_then(|d| d.parse::<u32>().ok()) {
        if (1..=24).contains(&n) && !lower[1..].starts_with('0') && lower[1..].chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("F{n}"));
        }
    }
    if let Some(n) = named_key(token) {
        return Some(n.to_string());
    }
    (token.chars().count() == 1 && "-=[];',./\\`".contains(token)).then(|| token.to_string())
}

/// "ctrl+shift+space" -> "Control+Shift+Space", or None if it isn't an acceptable shortcut.
pub fn normalize_accelerator(text: &str) -> Option<String> {
    if text.chars().count() > 60 {
        return None;
    }
    let tokens: Vec<&str> = text.split('+').map(str::trim).collect();
    if tokens.iter().any(|t| t.is_empty()) {
        return None; // empty parts: "Ctrl++", "+A"
    }
    let mut mods: BTreeSet<&'static str> = BTreeSet::new();
    let mut key: Option<String> = None;
    for t in tokens {
        if let Some(m) = modifier(t) {
            if !mods.insert(m) {
                return None;
            }
        } else {
            if key.is_some() {
                return None; // two keys
            }
            key = Some(normalize_key(t)?);
        }
    }
    let key = key?;
    if !(mods.contains("Control") || mods.contains("Alt") || mods.contains("Super")) {
        return None;
    }
    let mut parts: Vec<String> = ORDER.iter().filter(|m| mods.contains(*m)).map(|m| m.to_string()).collect();
    parts.push(key);
    let out = parts.join("+");
    (!RESERVED.contains(&out.as_str())).then_some(out)
}

#[derive(Debug, PartialEq, Eq)]
pub struct Sanitized {
    pub hotkeys: BTreeMap<&'static str, String>,
    /// Which ones were refused: "invalid", or "duplicate" when an earlier action already has that shortcut.
    pub problems: BTreeMap<&'static str, &'static str>,
}

/// Cleans what the page sent: { toggle, switcher, unread } with a shortcut or "" each.
pub fn sanitize_hotkeys(raw: &Value) -> Sanitized {
    let mut hotkeys: BTreeMap<&'static str, String> = ACTIONS.iter().map(|a| (*a, String::new())).collect();
    let mut problems = BTreeMap::new();
    let mut used = BTreeSet::new();
    for action in ACTIONS {
        let accel = match raw.get(action) {
            None | Some(Value::Null) => continue,
            Some(Value::String(s)) if s.is_empty() => continue,
            Some(Value::String(s)) => normalize_accelerator(s),
            Some(_) => None,
        };
        match accel {
            None => {
                problems.insert(action, "invalid");
            }
            Some(a) if used.contains(&a) => {
                problems.insert(action, "duplicate");
            }
            Some(a) => {
                used.insert(a.clone());
                hotkeys.insert(action, a);
            }
        }
    }
    Sanitized { hotkeys, problems }
}

pub trait Backend {
    /// True if it worked (false when another program has it).
    fn register(&mut self, accelerator: &str, action: &'static str) -> bool;
    fn unregister(&mut self, accelerator: &str);
}

pub struct Applied {
    pub hotkeys: BTreeMap<&'static str, String>,
    /// "ok", "off" (not set), "taken" (another program has it), "invalid" or "duplicate".
    pub status: BTreeMap<&'static str, String>,
}

pub struct HotkeyManager<B: Backend> {
    pub backend: B,
    active: Vec<String>,
}

impl<B: Backend> HotkeyManager<B> {
    pub fn new(backend: B) -> Self {
        HotkeyManager { backend, active: Vec::new() }
    }
    pub fn stop(&mut self) {
        for accel in self.active.drain(..) {
            self.backend.unregister(&accel);
        }
    }
    /// Replaces whatever was registered.
    pub fn apply(&mut self, raw: &Value) -> Applied {
        self.stop();
        let Sanitized { hotkeys, problems } = sanitize_hotkeys(raw);
        let mut status = BTreeMap::new();
        for action in ACTIONS {
            if let Some(p) = problems.get(action) {
                status.insert(action, p.to_string());
                continue;
            }
            let accel = hotkeys[action].clone();
            if accel.is_empty() {
                status.insert(action, "off".to_string());
                continue;
            }
            let ok = self.backend.register(&accel, action);
            if ok {
                self.active.push(accel);
            }
            status.insert(action, if ok { "ok" } else { "taken" }.to_string());
        }
        Applied { hotkeys, status }
    }
}

/// Converts a normalized shortcut ("Control+Alt+H") into the form the operating-system hook wants.
pub fn to_hotkey(accel: &str) -> Option<HotKey> {
    let mut mods = Modifiers::empty();
    let mut code = None;
    for part in accel.split('+') {
        match part {
            "Control" => mods |= Modifiers::CONTROL,
            "Alt" => mods |= Modifiers::ALT,
            "Shift" => mods |= Modifiers::SHIFT,
            "Super" => mods |= Modifiers::META, // the Windows key
            key => {
                let name = match key {
                    "Return" => "Enter".to_string(),
                    "Up" => "ArrowUp".into(), "Down" => "ArrowDown".into(), "Left" => "ArrowLeft".into(), "Right" => "ArrowRight".into(),
                    "-" => "Minus".into(), "=" => "Equal".into(), "[" => "BracketLeft".into(), "]" => "BracketRight".into(),
                    ";" => "Semicolon".into(), "'" => "Quote".into(), "," => "Comma".into(), "." => "Period".into(),
                    "/" => "Slash".into(), "\\" => "Backslash".into(), "`" => "Backquote".into(),
                    k if k.len() == 1 && k.chars().all(|c| c.is_ascii_uppercase()) => format!("Key{k}"),
                    k if k.len() == 1 && k.chars().all(|c| c.is_ascii_digit()) => format!("Digit{k}"),
                    k => k.to_string(), // F1..F24, Space, Tab, Backspace, Delete, Insert, Home, End, PageUp, PageDown, Escape
                };
                code = Some(Code::from_str(&name).ok()?);
            }
        }
    }
    Some(HotKey::new(Some(mods), code?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn shortcuts_are_tidied_into_one_standard_form() {
        let n = |s: &str| normalize_accelerator(s);
        assert_eq!(n("ctrl+shift+space").as_deref(), Some("Control+Shift+Space"));
        assert_eq!(n("Shift+Ctrl+h").as_deref(), Some("Control+Shift+H"));
        assert_eq!(n("Win+Alt+F5").as_deref(), Some("Alt+Super+F5"));
        assert_eq!(n("Control + Alt + Enter").as_deref(), Some("Control+Alt+Return"));
        assert_eq!(n("ctrl+alt+1").as_deref(), Some("Control+Alt+1"));
        assert_eq!(n("ctrl+alt+up").as_deref(), Some("Control+Alt+Up"));
        assert_eq!(n("ctrl+alt+/").as_deref(), Some("Control+Alt+/"));
        assert_eq!(n("ctrl+f24").as_deref(), Some("Control+F24"));
    }
    #[test]
    fn a_shortcut_needs_ctrl_alt_or_the_windows_key() {
        for bad in ["A", "Shift+A", "F5", "Space", "Shift+Space", "Shift+F5", "Shift", "Ctrl"] {
            assert_eq!(normalize_accelerator(bad), None, "{bad}");
        }
    }
    #[test]
    fn malformed_shortcuts_are_refused() {
        let long = "x".repeat(100);
        for bad in ["", "+", "Ctrl+", "Ctrl++A", "Ctrl+A+B", "Ctrl+Ctrl+A", "Ctrl+Nope", "Ctrl+F25", "Ctrl+F0", "Ctrl+Alt+Win+Shift+AB", long.as_str()] {
            assert_eq!(normalize_accelerator(bad), None, "{bad}");
        }
    }
    #[test]
    fn combinations_the_system_keeps_for_itself_are_refused() {
        for r in ["Alt+F4", "alt+tab", "Ctrl+Alt+Delete", "Win+L", "Win+D", "Ctrl+Esc"] {
            assert_eq!(normalize_accelerator(r), None, "{r}");
        }
    }
    #[test]
    fn sanitizing_keeps_good_shortcuts_blanks_bad_ones_and_flags_a_repeat() {
        let r = sanitize_hotkeys(&json!({"toggle": "ctrl+alt+h", "switcher": "nonsense", "unread": "Alt+Control+H"}));
        assert_eq!(r.hotkeys["toggle"], "Control+Alt+H");
        assert_eq!(r.hotkeys["switcher"], "");
        assert_eq!(r.hotkeys["unread"], "");
        assert_eq!(r.problems.get("switcher"), Some(&"invalid"));
        assert_eq!(r.problems.get("unread"), Some(&"duplicate"));
        assert!(sanitize_hotkeys(&json!(null)).problems.is_empty());
        assert!(sanitize_hotkeys(&json!({"toggle": "", "switcher": null})).problems.is_empty());
        assert_eq!(sanitize_hotkeys(&json!({"bogus": "Ctrl+Alt+Z"})).hotkeys.values().filter(|v| !v.is_empty()).count(), 0);
        assert_eq!(sanitize_hotkeys(&json!({"toggle": 5})).problems.get("toggle"), Some(&"invalid"));
    }

    #[derive(Default)]
    struct Rig {
        taken: Vec<String>,
        registered: HashMap<String, &'static str>,
    }
    impl Backend for Rig {
        fn register(&mut self, accel: &str, action: &'static str) -> bool {
            if self.taken.iter().any(|t| t == accel) {
                return false;
            }
            self.registered.insert(accel.to_string(), action);
            true
        }
        fn unregister(&mut self, accel: &str) {
            self.registered.remove(accel);
        }
    }

    #[test]
    fn registering_ties_each_shortcut_to_its_action() {
        let mut m = HotkeyManager::new(Rig::default());
        let out = m.apply(&json!({"toggle": "Ctrl+Alt+H", "unread": "Ctrl+Alt+U"}));
        assert_eq!((out.status["toggle"].as_str(), out.status["switcher"].as_str(), out.status["unread"].as_str()), ("ok", "off", "ok"));
        assert_eq!(m.backend.registered["Control+Alt+H"], "toggle");
        assert_eq!(m.backend.registered["Control+Alt+U"], "unread");
    }
    #[test]
    fn a_shortcut_another_program_already_has_is_reported_as_taken() {
        let mut m = HotkeyManager::new(Rig { taken: vec!["Control+Alt+H".into()], ..Default::default() });
        let out = m.apply(&json!({"toggle": "Ctrl+Alt+H", "switcher": "Ctrl+Alt+K"}));
        assert_eq!((out.status["toggle"].as_str(), out.status["switcher"].as_str(), out.status["unread"].as_str()), ("taken", "ok", "off"));
        assert_eq!(out.hotkeys["toggle"], "Control+Alt+H"); // still remembered, so it can work if the other program lets go
        assert_eq!(m.backend.registered.keys().collect::<Vec<_>>(), ["Control+Alt+K"]);
    }
    #[test]
    fn applying_again_replaces_the_old_shortcuts_and_stop_removes_them_all() {
        let mut m = HotkeyManager::new(Rig::default());
        m.apply(&json!({"toggle": "Ctrl+Alt+H"}));
        m.apply(&json!({"switcher": "Ctrl+Alt+K"}));
        assert_eq!(m.backend.registered.keys().collect::<Vec<_>>(), ["Control+Alt+K"]);
        m.stop();
        assert!(m.backend.registered.is_empty());
    }
    #[test]
    fn every_accepted_shortcut_converts_for_the_system_hook() {
        for s in ["Control+Shift+Space", "Control+Alt+Return", "Alt+Super+F5", "Control+Alt+1", "Control+Alt+Up", "Control+Alt+/", "Control+F24", "Control+Alt+PageDown", "Control+Alt+`", "Control+Alt+Z"] {
            assert!(to_hotkey(s).is_some(), "{s}");
        }
    }
}
