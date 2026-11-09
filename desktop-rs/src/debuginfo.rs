//! The text behind "Troubleshooting → Copy debug info": versions, what the app is doing and
//! the last few log lines, ready to paste when asking for help. It holds no messages, passwords or sign-in details, and only
//! the server's host name.
use crate::log::redact;

pub struct DebugInfo {
    pub app_version: String,
    pub packaged: bool,
    pub platform: String,
    pub arch: String,
    pub os_version: String,
    pub webview: String,
    pub server_url: Option<String>,
    pub uptime_seconds: u64,
    pub update_status: String,
    pub update_version: Option<String>,
    pub update_message: Option<String>,
    pub memory_mb: Option<u64>,
    pub page_loaded: bool,
    pub close_to_tray: bool,
    pub launch_at_startup: bool,
    pub start_in_background: bool,
    pub unload_when_hidden: bool,
    pub crash_reports: usize,
    pub log_tail: Vec<String>,
}

fn host_of(url: &Option<String>) -> String {
    url.as_deref().and_then(|u| url::Url::parse(u).ok()).and_then(|u| u.host_str().map(|h| match u.port() { Some(p) => format!("{h}:{p}"), None => h.to_string() })).unwrap_or_else(|| "not set".into())
}

fn on_off(v: bool) -> &'static str {
    if v { "on" } else { "off" }
}

pub fn format_debug_info(i: &DebugInfo) -> String {
    let mut lines = vec![
        format!("Huddle desktop {}{}", i.app_version, if i.packaged { "" } else { " (running from source)" }),
        format!("Rust build · {}", i.webview),
        format!("{} {} · {}", i.platform, i.arch, i.os_version),
        format!("Server: {}", host_of(&i.server_url)),
        format!("Running for: {} min", (i.uptime_seconds as f64 / 60.0).round() as u64),
        format!(
            "Updates: {}{}{}",
            i.update_status,
            i.update_version.as_ref().map(|v| format!(" ({v})")).unwrap_or_default(),
            i.update_message.as_ref().map(|m| format!(" · {}", redact(m))).unwrap_or_default()
        ),
    ];
    if let Some(mb) = i.memory_mb {
        lines.push(format!("Memory: about {mb} MB · page {}", if i.page_loaded { "loaded" } else { "unloaded" }));
    }
    lines.push(format!(
        "Settings: tray {} · start with computer {} · start hidden {} · free memory when hidden {}",
        on_off(i.close_to_tray), on_off(i.launch_at_startup), on_off(i.start_in_background), on_off(i.unload_when_hidden)
    ));
    lines.push(format!("Crash reports saved: {}", i.crash_reports));
    lines.push(String::new());
    lines.push(if i.log_tail.is_empty() { "Recent log: (empty)".into() } else { "Recent log:".into() });
    lines.extend(i.log_tail.iter().cloned());
    redact(&lines.join("\n")).chars().take(12000).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> DebugInfo {
        DebugInfo {
            app_version: "2.0.0".into(), packaged: true, platform: "windows".into(), arch: "x86_64".into(), os_version: "Windows 11".into(), webview: "WebView2 130".into(),
            server_url: Some("https://huddle.example.com/secret/path?token=abc".into()), uptime_seconds: 125, update_status: "idle".into(), update_version: None,
            update_message: None, memory_mb: Some(180), page_loaded: true, close_to_tray: true, launch_at_startup: false, start_in_background: false,
            unload_when_hidden: true, crash_reports: 0, log_tail: vec!["2026-01-01T00:00:00.000Z INFO started".into()],
        }
    }
    #[test]
    fn only_the_host_name_is_included() {
        let text = format_debug_info(&sample());
        assert!(text.contains("Server: huddle.example.com\n"));
        assert!(!text.contains("secret/path") && !text.contains("token=abc"));
        assert!(text.contains("Running for: 2 min") && text.contains("Memory: about 180 MB · page loaded"));
    }
    #[test]
    fn secrets_in_the_log_are_hidden() {
        let mut s = sample();
        s.log_tail = vec!["2026-01-01T00:00:00.000Z ERROR failed password=hunter2".into()];
        let text = format_debug_info(&s);
        assert!(!text.contains("hunter2") && text.contains("password=[hidden]"));
    }
}
