//! The operating-system specifics: one running copy at a time, starting with the computer, `huddle://` links, the screen's
//! usable area (for popups) and the taskbar badge.
//!
//! The Windows branches are the ones that matter for shipping and are the only code here that could not be compiled on the
//! machine this was written on: they need a first build on Windows (see desktop-rs/WINDOWS-CHECKLIST.md).
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions, Stream};
use std::io::{BufRead, BufReader, Write};
#[cfg(target_os = "linux")]
use std::path::PathBuf;

// ---------- one copy at a time ----------

fn socket_name() -> String {
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let clean: String = user.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    format!("huddle-desktop-{clean}")
}

pub enum Instance {
    /// We are the first copy; the listener passes on what later launches ask for.
    First(Option<interprocess::local_socket::Listener>),
    /// Another copy is running and has been told what this launch wanted.
    Second,
}

/// Tries to hand `args` to a copy that is already running.
pub fn acquire(args: &[String]) -> Instance {
    let Ok(name) = socket_name().to_ns_name::<GenericNamespaced>() else { return Instance::First(None) };
    if let Ok(mut stream) = Stream::connect(name.clone()) {
        let line = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
        let _ = stream.write_all(format!("{line}\n").as_bytes());
        return Instance::Second;
    }
    match ListenerOptions::new().name(name).create_sync() {
        Ok(l) => Instance::First(Some(l)),
        Err(_) => Instance::First(None), // couldn't claim the name: carry on without the single-copy check
    }
}

/// Waits (on its own thread) for later launches and calls `on_args` with what each one asked for.
pub fn listen(listener: interprocess::local_socket::Listener, on_args: impl Fn(Vec<String>) + Send + 'static) {
    std::thread::spawn(move || {
        for conn in listener.incoming().filter_map(Result::ok) {
            let mut line = String::new();
            if BufReader::new(conn).take(8192).read_line(&mut line).is_ok() {
                if let Ok(args) = serde_json::from_str::<Vec<String>>(line.trim()) {
                    on_args(args.into_iter().take(32).collect());
                }
            }
        }
    });
}
use std::io::Read;

// ---------- starting with the computer ----------

pub fn apply_autostart(enabled: bool, hidden: bool, log: &dyn Fn(&str)) {
    let Ok(exe) = std::env::current_exe() else { return };
    let args: Vec<&str> = if hidden { vec!["--hidden"] } else { vec![] };
    let built = auto_launch::AutoLaunchBuilder::new().set_app_name("Huddle").set_app_path(&exe.to_string_lossy()).set_args(&args).build();
    match built {
        Ok(al) => {
            let r = if enabled { al.enable() } else if al.is_enabled().unwrap_or(false) { al.disable() } else { Ok(()) };
            if let Err(e) = r {
                log(&format!("Couldn't update the start-with-computer setting: {e}"));
            }
        }
        Err(e) => log(&format!("Couldn't update the start-with-computer setting: {e}")),
    }
}

// ---------- huddle:// links ----------

pub fn register_protocol(log: &dyn Fn(&str)) {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let result = (|| -> std::io::Result<()> {
            let exe = std::env::current_exe()?;
            let root = RegKey::predef(HKEY_CURRENT_USER).create_subkey("Software\\Classes\\huddle")?.0;
            root.set_value("", &"URL:Huddle")?;
            root.set_value("URL Protocol", &"")?;
            let cmd = root.create_subkey("shell\\open\\command")?.0;
            cmd.set_value("", &format!("\"{}\" \"%1\"", exe.display()))?;
            Ok(())
        })();
        if let Err(e) = result {
            log(&format!("Couldn't register huddle:// links: {e}"));
        }
    }
    #[cfg(target_os = "linux")]
    {
        let result = (|| -> std::io::Result<()> {
            let exe = std::env::current_exe()?;
            let dir = dirs::data_dir().unwrap_or_else(|| PathBuf::from(".")).join("applications");
            std::fs::create_dir_all(&dir)?;
            std::fs::write(dir.join("huddle.desktop"), format!("[Desktop Entry]\nType=Application\nName=Huddle\nExec=\"{}\" %u\nTerminal=false\nMimeType=x-scheme-handler/huddle;\n", exe.display()))?;
            let _ = std::process::Command::new("xdg-mime").args(["default", "huddle.desktop", "x-scheme-handler/huddle"]).status();
            Ok(())
        })();
        if let Err(e) = result {
            log(&format!("Couldn't register huddle:// links: {e}"));
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = log;
}

// ---------- screen area, platform name ----------

/// The part of the primary screen that isn't covered by the taskbar: (left, top, right, bottom) in physical pixels.
pub fn work_area() -> Option<(i32, i32, i32, i32)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        // SAFETY: SPI_GETWORKAREA writes one RECT into the buffer we pass.
        let ok = unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut r as *mut RECT as *mut _, 0) };
        return (ok != 0).then_some((r.left, r.top, r.right, r.bottom));
    }
    #[cfg(not(windows))]
    None
}

/// Electron's `process.platform` names, which is what the page expects.
pub fn platform_name() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => if other == "linux" { "linux" } else { "linux" },
    }
}

/// Decodes a `data:image/png;base64,...` URL (the page's badge picture) into a window icon. Refuses anything else or too large.
#[cfg_attr(not(windows), allow(dead_code))] // only the Windows taskbar badge uses it
pub fn icon_from_data_url(url: &str) -> Option<tao::window::Icon> {
    use base64::Engine;
    let b64 = url.strip_prefix("data:image/png;base64,")?;
    if url.len() >= 60_000 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    icon_from_png(&bytes, None)
}

/// A PNG as a window icon, optionally resized to `size` pixels square.
pub fn icon_from_png(png: &[u8], size: Option<u32>) -> Option<tao::window::Icon> {
    let (rgba, w, h) = rgba_from_png(png, size)?;
    tao::window::Icon::from_rgba(rgba, w, h).ok()
}

pub fn rgba_from_png(png: &[u8], size: Option<u32>) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(png, image::ImageFormat::Png).ok()?;
    let img = match size {
        Some(s) => img.resize_exact(s, s, image::imageops::FilterType::Lanczos3),
        None => img,
    };
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Some((rgba.into_raw(), w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_apps_icons_decode() {
        assert!(rgba_from_png(crate::ui::ICON_PNG, None).is_some());
        assert_eq!(rgba_from_png(crate::ui::TRAY_PNG, Some(20)).map(|(_, w, h)| (w, h)), Some((20, 20)));
        assert!(rgba_from_png(crate::ui::TRAY_UNREAD_PNG, Some(20)).is_some());
        assert!(rgba_from_png(b"not a png", None).is_none());
    }
    #[test]
    fn badge_pictures_must_be_small_png_data_urls() {
        assert!(icon_from_data_url("https://x/y.png").is_none());
        assert!(icon_from_data_url("data:image/svg+xml;base64,AAAA").is_none());
        assert!(icon_from_data_url(&format!("data:image/png;base64,{}", "A".repeat(70_000))).is_none());
    }
    #[test]
    fn platform_names_match_electrons() {
        assert!(["win32", "darwin", "linux"].contains(&platform_name()));
    }
}
