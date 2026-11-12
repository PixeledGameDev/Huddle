//! Settings: a small JSON file in the user's app data folder.
//!
//! The file lives at %APPDATA%\Huddle\settings.json on Windows, the same place (and with the same key names) the old Electron app
//! used, so the server address and choices carry over from an old install. Unknown keys are ignored.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Bounds {
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub server_url: Option<String>,
    pub close_to_tray: bool,
    /// Logical (device-independent) pixels.
    pub bounds: Option<Bounds>,
    pub maximized: bool,
    pub launch_at_startup: bool,
    pub start_in_background: bool,
    pub last_run_version: Option<String>,
    /// The version the update installer was last started for. Still newer than the running app at the next launch means the
    /// install didn't work, so the splash screen must not try it again (see `update::should_install_at_startup`).
    pub install_attempt: Option<String>,
    pub unload_when_hidden: bool,
    pub notify_prefs: Option<Value>,
    pub auto_idle: bool,
    pub auto_idle_minutes: u32,
    pub hotkeys: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            server_url: None,
            close_to_tray: true,
            bounds: None,
            maximized: false,
            launch_at_startup: true,
            start_in_background: false,
            last_run_version: None,
            install_attempt: None,
            unload_when_hidden: true,
            notify_prefs: None,
            auto_idle: true,
            auto_idle_minutes: 10,
            hotkeys: BTreeMap::new(),
        }
    }
}

pub fn data_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("Huddle")
}

pub fn settings_file() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn load() -> Settings {
    std::fs::read_to_string(settings_file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(s: &Settings) -> std::io::Result<()> {
    let file = settings_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Write to a side file first so a crash mid-write can't leave half a settings file.
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(s).map_err(std::io::Error::other)?)?;
    std::fs::rename(tmp, file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_electron_app() {
        let s = Settings::default();
        assert!(s.close_to_tray && s.launch_at_startup && s.unload_when_hidden && s.auto_idle);
        assert!(!s.start_in_background && !s.maximized);
        assert_eq!(s.auto_idle_minutes, 10);
    }
    #[test]
    fn an_electron_settings_file_loads_and_unknown_keys_are_ignored() {
        let s: Settings = serde_json::from_str(r#"{"serverUrl":"https://h.example.com","closeToTray":false,"lowGraphics":true,"bounds":{"x":10,"y":20,"width":1200,"height":800},"hotkeys":{"toggle":"Control+Alt+H","switcher":"","unread":""}}"#).unwrap();
        assert_eq!(s.server_url.as_deref(), Some("https://h.example.com"));
        assert!(!s.close_to_tray && s.unload_when_hidden);
        assert_eq!(s.bounds.unwrap().width, 1200.0);
        assert_eq!(s.hotkeys["toggle"], "Control+Alt+H");
    }
    #[test]
    fn garbage_gives_defaults() {
        assert!(serde_json::from_str::<Settings>("not json").is_err());
        assert!(serde_json::from_str::<Settings>("{}").unwrap().close_to_tray);
    }
}
