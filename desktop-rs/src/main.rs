//! Huddle desktop: a window onto your Huddle server, plus the desktop extras (system notifications, an unread badge, a tray
//! icon, and staying open in the tray when you close the window). A Rust port of the Electron app in ../desktop.
//!
//! The app contains no copy of Huddle itself. It loads your server's own web app, so it is always the same version as the
//! server, and signing in works exactly like it does in a browser.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod app;
mod background;
mod crashguard;
mod debuginfo;
mod deeplink;
mod hotkeys;
mod idle;
mod log;
mod platform;
mod quiet;
mod settings;
mod ui;
mod update;
mod url;

use std::sync::Arc;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch = deeplink::parse_launch_args(&args);
    // One copy at a time: a second launch (a huddle:// link, a taskbar command) is handed to the one already running.
    let listener = match platform::acquire(&args) {
        platform::Instance::Second => return,
        platform::Instance::First(l) => l,
    };
    if launch.quit {
        return; // "Quit Huddle" when Huddle isn't running: nothing to do
    }
    let logger = Arc::new(log::Logger::new(settings::data_dir().join("logs"), cfg!(debug_assertions)));
    let default_hook = std::panic::take_hook();
    let panic_logger = logger.clone();
    std::panic::set_hook(Box::new(move |info| {
        panic_logger.error(format!("Uncaught error: {info}"));
        default_hook(info);
    }));
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("couldn't start the background runtime");
    let _guard = rt.enter();
    app::run(rt, logger, listener, args)
}
