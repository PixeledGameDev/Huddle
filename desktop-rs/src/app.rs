//! The application: windows, the tray, popups and everything that ties the pieces together (port of desktop/src/main.js).
//!
//! Everything here runs on the main thread inside the window system's event loop. Work that happens elsewhere (timers, the
//! network, the idle check, other launches of the app) comes back as a `UserEvent::Run` job that is executed with `&mut App`.
use crate::background::{Background, BgEvent, Note, Prefs};
use crate::debuginfo::{format_debug_info, DebugInfo};
use crate::deeplink::{invite_path, parse_launch_args};
use crate::hotkeys::{self, HotkeyManager};
use crate::idle::{sanitize_idle_settings, IdleSettings, IdleTracker};
use crate::log::Logger;
use crate::quiet::{is_quiet_now, sanitize_quiet};
use crate::settings::{self, Bounds, Settings};
use crate::update::{can_auto_update, launch_installer, update_feed_url, Schedule, UpdateNotifier, UpdateState, Updater};
use crate::url::{is_safe_external, normalize_server_url, same_origin};
use crate::{platform, ui};
use global_hotkey::{GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState};
use muda::{CheckMenuItem, ContextMenu, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event::{Event, StartCause, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy, EventLoopWindowTarget};
use tao::window::{Fullscreen, ProgressBarState, ProgressState, UserAttentionType, Window, WindowBuilder, WindowId};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use wry::{WebContext, WebView, WebViewBuilder};

const TITLEBAR_H: f64 = 40.0;
const SPLASH_MIN: Duration = Duration::from_millis(1200); // long enough to read, short enough not to feel slow
const UNLOAD_AFTER: Duration = Duration::from_secs(2 * 60);
const TOAST_W: f64 = 380.0;
const TOAST_H: f64 = 178.0;
const MAX_TOASTS: usize = 3;
const BG_COLOR: (u8, u8, u8, u8) = (15, 19, 34, 255); // #0f1322

pub type Target = EventLoopWindowTarget<UserEvent>;
pub type Job = Box<dyn FnOnce(&mut App, &Target) + Send>;

pub enum UserEvent {
    /// Something that happened elsewhere (a timer, the network, another launch) and needs the app's state.
    Run(Job),
    /// A message from a page. `uri` is the address of the page that sent it, which decides whether it is believed.
    Ipc { wid: WindowId, uri: String, body: String },
    Tray(TrayIconEvent),
    Menu(MenuEvent),
    Hotkey(&'static str),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Main,
    Splash,
    Dialog,
    Toast,
}

struct Win {
    window: Window,
    webview: WebView,
    kind: Kind,
}

/// What background threads and window handlers need to read; kept up to date by the app.
#[derive(Default)]
pub struct Shared {
    pub server_url: Mutex<Option<String>>,
    pub notify_prefs: Mutex<Value>,
}

struct DialogState {
    opts: Value,
    buttons: usize,
    cancel_id: usize,
    then: Option<Box<dyn FnOnce(&mut App, &Target, usize)>>,
}

struct Toast {
    wid: WindowId,
    tag: String,
    target: Option<(String, String)>, // (server id, channel id)
    held: bool,
    update: Option<String>,
    content: Value,
    tok: u64,
    ms: u64,
}

struct GlobalBackend {
    manager: Option<GlobalHotKeyManager>,
    ids: Arc<Mutex<HashMap<u32, &'static str>>>,
    keys: HashMap<String, global_hotkey::hotkey::HotKey>,
}

impl hotkeys::Backend for GlobalBackend {
    fn register(&mut self, accelerator: &str, action: &'static str) -> bool {
        let (Some(manager), Some(hk)) = (&self.manager, hotkeys::to_hotkey(accelerator)) else { return false };
        if manager.register(hk).is_err() {
            return false;
        }
        self.ids.lock().unwrap().insert(hk.id(), action);
        self.keys.insert(accelerator.to_string(), hk);
        true
    }
    fn unregister(&mut self, accelerator: &str) {
        if let (Some(manager), Some(hk)) = (&self.manager, self.keys.remove(accelerator)) {
            let _ = manager.unregister(hk);
            self.ids.lock().unwrap().remove(&hk.id());
        }
    }
}

pub struct App {
    proxy: EventLoopProxy<UserEvent>,
    rt: tokio::runtime::Handle,
    pub logger: Arc<Logger>,
    shared: Arc<Shared>,
    started: Instant,
    packaged: bool,
    settings: Settings,
    save_gen: u64,
    windows: HashMap<WindowId, Win>,
    main_id: Option<WindowId>,
    splash_id: Option<WindowId>,
    splash_shown_at: Option<Instant>,
    splash_status: Value,
    dialogs: HashMap<WindowId, DialogState>,
    toasts: Vec<Toast>, // newest first
    toast_seq: u64,
    tray: Option<TrayIcon>,
    unread_count: usize,
    quitting: bool,
    pub should_exit: bool,
    start_hidden: bool,
    shown_once: bool,
    page_ready: bool,
    pending_target: Option<(String, String)>,
    pending_command: Option<&'static str>,
    initial_path: Option<String>,
    just_updated_from: Option<String>,
    unload_gen: u64,
    keep_alive: bool,
    background: Option<Arc<Background>>,
    zoom_level: f64,
    updater: Option<Arc<Updater>>,
    update_notifier: UpdateNotifier,
    schedule: Schedule,
    last_update_check: Arc<Mutex<Option<Instant>>>,
    update_poke: Arc<tokio::sync::Notify>,
    in_startup_update: bool,
    idle: Option<IdleTracker>,
    hotkey_mgr: HotkeyManager<GlobalBackend>,
    hotkey_status: Value,
    hotkey_pause_gen: u64,
    last_hotkey_at: HashMap<&'static str, Instant>,
    pending_replies: HashMap<u64, (WindowId, u64)>, // reply id -> (popup, the popup's request id)
    reply_seq: u64,
    _instance_listener: bool,
}

fn jstr(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

fn text(v: &Value, max: usize) -> String {
    v.as_str().map(|s| s.chars().take(max).collect()).unwrap_or_default()
}

fn is_uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.len() == 36 && s.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
}

impl App {
    pub fn new(event_loop: &EventLoop<UserEvent>, rt: tokio::runtime::Handle, logger: Arc<Logger>, listener_active: bool) -> App {
        let proxy = event_loop.create_proxy();
        let settings = settings::load();
        let shared = Arc::new(Shared::default());
        *shared.notify_prefs.lock().unwrap() = settings.notify_prefs.clone().unwrap_or(Value::Null);
        let ids: Arc<Mutex<HashMap<u32, &'static str>>> = Arc::default();
        let manager = if hotkeys_supported() { GlobalHotKeyManager::new().ok() } else { None };
        {
            let (ids, proxy) = (ids.clone(), proxy.clone());
            GlobalHotKeyEvent::set_event_handler(Some(move |e: GlobalHotKeyEvent| {
                if e.state == HotKeyState::Pressed {
                    if let Some(action) = ids.lock().unwrap().get(&e.id).copied() {
                        let _ = proxy.send_event(UserEvent::Hotkey(action));
                    }
                }
            }));
        }
        {
            let p = proxy.clone();
            TrayIconEvent::set_event_handler(Some(move |e| { let _ = p.send_event(UserEvent::Tray(e)); }));
            let p = proxy.clone();
            MenuEvent::set_event_handler(Some(move |e| { let _ = p.send_event(UserEvent::Menu(e)); }));
        }
        let app = App {
            proxy, rt, logger, shared, started: Instant::now(), packaged: !cfg!(debug_assertions), settings, save_gen: 0,
            windows: HashMap::new(), main_id: None, splash_id: None, splash_shown_at: None, splash_status: json!({"text": "Starting…"}),
            dialogs: HashMap::new(), toasts: Vec::new(), toast_seq: 0, tray: None, unread_count: 0, quitting: false, should_exit: false,
            start_hidden: false, shown_once: false, page_ready: false, pending_target: None, pending_command: None, initial_path: None,
            just_updated_from: None, unload_gen: 0, keep_alive: false, background: None, zoom_level: 0.0, updater: None,
            update_notifier: UpdateNotifier::new(), schedule: Schedule::default(), last_update_check: Arc::default(),
            update_poke: Arc::new(tokio::sync::Notify::new()), in_startup_update: false, idle: None,
            hotkey_mgr: HotkeyManager::new(GlobalBackend { manager, ids, keys: HashMap::new() }), hotkey_status: json!({}), hotkey_pause_gen: 0,
            last_hotkey_at: HashMap::new(), pending_replies: HashMap::new(), reply_seq: 0,
            _instance_listener: listener_active,
        };
        *app.shared.server_url.lock().unwrap() = app.server_url();
        app
    }

    // ---------- small helpers ----------

    fn later(&self, delay: Duration, job: impl FnOnce(&mut App, &Target) + Send + 'static) {
        let proxy = self.proxy.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(delay).await;
            let _ = proxy.send_event(UserEvent::Run(Box::new(job)));
        });
    }
    /// Runs `fut` on the network runtime and then `done` with its result back on the main thread.
    fn spawn<T: Send + 'static>(&self, fut: impl std::future::Future<Output = T> + Send + 'static, done: impl FnOnce(&mut App, &Target, T) + Send + 'static) {
        let proxy = self.proxy.clone();
        self.rt.spawn(async move {
            let out = fut.await;
            let _ = proxy.send_event(UserEvent::Run(Box::new(move |app, t| done(app, t, out))));
        });
    }
    fn eval(&self, wid: WindowId, js: &str) {
        if let Some(w) = self.windows.get(&wid) {
            let _ = w.webview.evaluate_script(js);
        }
    }
    fn resolve(&self, wid: WindowId, id: u64, value: Value) {
        self.eval(wid, &format!("(window.__huddle?window.__huddle.resolve:window.__resolve)({id},{})", jstr(&value)));
    }
    fn emit(&self, wid: WindowId, name: &str, payload: &Value) {
        self.eval(wid, &format!("(window.__huddle?window.__huddle.emit:window.__emit)({},{})", jstr(&json!(name)), jstr(payload)));
    }
    fn emit_main(&self, name: &str, payload: &Value) {
        if let Some(id) = self.main_id {
            self.emit(id, name, payload);
        }
    }
    fn main_window(&self) -> Option<&Win> {
        self.main_id.and_then(|id| self.windows.get(&id))
    }
    fn server_url(&self) -> Option<String> {
        if let Some(u) = &self.settings.server_url {
            return Some(u.clone());
        }
        let configured = std::env::var("HUDDLE_URL").ok().and_then(|u| normalize_server_url(&u)).or_else(|| {
            let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
            let text = std::fs::read_to_string(dir.join("app.config.json")).ok()?;
            normalize_server_url(serde_json::from_str::<Value>(&text).ok()?["defaultUrl"].as_str()?)
        });
        configured.or_else(|| normalize_server_url(option_env!("HUDDLE_DEFAULT_URL").unwrap_or("")))
    }
    fn quiet_now(&self) -> bool {
        is_quiet_now(&Prefs::from_json(&self.settings.notify_prefs.clone().unwrap_or(Value::Null)).quiet)
    }
    fn save_settings(&mut self) {
        self.save_gen += 1;
        let tok = self.save_gen;
        self.later(Duration::from_millis(300), move |app, _| {
            if app.save_gen == tok {
                app.flush_settings();
            }
        });
    }
    fn flush_settings(&self) {
        if let Err(e) = settings::save(&self.settings) {
            self.logger.error(format!("Couldn't save settings: {e}"));
        }
    }
    fn beep(&self) {
        #[cfg(windows)]
        // SAFETY: MessageBeep takes only a sound type and has no pointers.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::MessageBeep(0);
        }
    }

    // ---------- start up ----------

    pub fn start(&mut self, target: &Target, args: &[String]) {
        let launch = parse_launch_args(args);
        self.initial_path = invite_path(&launch.deep_link);
        self.logger.info(format!("Huddle {} starting · {} {}{}", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH, if self.packaged { "" } else { " · from source" }));
        self.note_version_change();
        self.create_tray(target);
        self.init_idle();
        self.apply_hotkeys();
        if self.packaged {
            let log = self.logger.clone();
            platform::register_protocol(&move |m| log.error(m));
        }
        self.apply_startup();
        self.start_hidden = launch.hidden && self.settings.launch_at_startup && self.settings.start_in_background && self.tray.is_some();
        self.init_updater();
        self.build_menus();
        if !self.start_hidden {
            self.show_splash(target);
        }
        self.set_splash("Starting…", None);
        self.startup_update();
    }

    fn note_version_change(&mut self) {
        let now = env!("CARGO_PKG_VERSION");
        if let Some(prev) = &self.settings.last_run_version {
            if prev != now {
                self.just_updated_from = Some(prev.clone());
            }
        }
        if self.settings.last_run_version.as_deref() != Some(now) {
            self.settings.last_run_version = Some(now.into());
            self.save_settings();
        }
    }

    // ---------- webviews ----------

    fn build_webview(&self, window: &Window, kind: Kind, url: &str, transparent: bool) -> Result<WebView, String> {
        let wid = window.id();
        let mut ctx = WebContext::new(Some(settings::data_dir().join("webview")));
        let proxy = self.proxy.clone();
        let mut b = WebViewBuilder::new_with_web_context(&mut ctx)
            .with_url(url)
            .with_transparent(transparent)
            .with_background_color(if transparent { (0, 0, 0, 0) } else { BG_COLOR })
            .with_custom_protocol(ui::SCHEME.into(), |_, req| ui::serve(req))
            .with_ipc_handler(move |req| {
                let _ = proxy.send_event(UserEvent::Ipc { wid, uri: req.uri().to_string(), body: req.body().clone() });
            })
            // Huddle needs no browser-style permissions beyond copying to the clipboard and going fullscreen.
            .with_permission_handler(|kind| permission_response(&kind));
        if kind == Kind::Main {
            let bridge = ui::BRIDGE.replace("__VERSION__", env!("CARGO_PKG_VERSION")).replace("__PLATFORM__", platform::platform_name());
            let (shared, shared2, shared3) = (self.shared.clone(), self.shared.clone(), self.shared.clone());
            let (p1, p2, p3) = (self.proxy.clone(), self.proxy.clone(), self.proxy.clone());
            b = b
                .with_devtools(true)
                .with_initialization_script_for_main_only(bridge, true)
                // Only Huddle itself loads in this window. Everything else opens in the person's own browser.
                .with_navigation_handler(move |url| {
                    let server = shared.server_url.lock().unwrap().clone();
                    if url.starts_with("about:") || ui::is_local(&url) || same_origin(&url, server.as_deref()) {
                        return true;
                    }
                    if is_safe_external(&url) {
                        let _ = open::that(&url);
                    }
                    false
                })
                .with_new_window_req_handler(move |url, _| {
                    let server = shared2.server_url.lock().unwrap().clone();
                    if same_origin(&url, server.as_deref()) {
                        // A file from Huddle: download it, signed in.
                        let js = format!("{{const a=document.createElement('a');a.href={};a.download='';document.body.appendChild(a);a.click();a.remove();}}", jstr(&json!(url)));
                        let _ = p1.send_event(UserEvent::Run(Box::new(move |app, _| app.eval_main_script(&js))));
                    } else if is_safe_external(&url) {
                        let _ = open::that(&url);
                    }
                    wry::NewWindowResponse::Deny
                })
                .with_download_started_handler(|_url, path| {
                    // Like the old app, ask where to save it.
                    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "download".into());
                    let mut dialog = rfd::FileDialog::new().set_file_name(&name);
                    if let Some(dir) = dirs::download_dir() {
                        dialog = dialog.set_directory(dir);
                    }
                    match dialog.save_file() {
                        Some(chosen) => { *path = chosen; true }
                        None => false,
                    }
                })
                .with_document_title_changed_handler(move |title| {
                    let _ = p2.send_event(UserEvent::Run(Box::new(move |app, _| {
                        if let Some(w) = app.main_window() { w.window.set_title(&title); }
                    })));
                })
                .with_on_page_load_handler(move |event, _| {
                    if matches!(event, wry::PageLoadEvent::Finished) {
                        let _ = p3.send_event(UserEvent::Run(Box::new(move |app, t| app.on_main_page_loaded(t, wid))));
                    }
                });
            let _ = shared3;
        }
        build_in_window(b, window)
    }

    fn eval_main_script(&self, js: &str) {
        if let Some(w) = self.main_window() {
            let _ = w.webview.evaluate_script(js);
        }
    }

    // ---------- the splash screen ----------

    fn show_splash(&mut self, target: &Target) {
        let window = match WindowBuilder::new()
            .with_inner_size(LogicalSize::new(420.0, 380.0))
            .with_decorations(false)
            .with_resizable(false)
            .with_maximizable(false)
            .with_minimizable(false)
            .with_title("Huddle")
            .with_visible(false)
            .with_window_icon(platform::icon_from_png(ui::ICON_PNG, None))
            .build(target)
        {
            Ok(w) => w,
            Err(e) => return self.logger.error(format!("Couldn't open the splash screen: {e}")),
        };
        center(&window, target);
        let wid = window.id();
        match self.build_webview(&window, Kind::Splash, &ui::page_url("splash.html"), false) {
            Ok(webview) => {
                window.set_visible(true);
                self.splash_shown_at = Some(Instant::now());
                self.splash_id = Some(wid);
                self.windows.insert(wid, Win { window, webview, kind: Kind::Splash });
            }
            Err(e) => self.logger.error(format!("Couldn't draw the splash screen: {e}")),
        }
    }
    fn set_splash(&mut self, text: &str, percent: Option<u8>) {
        self.splash_status = json!({"text": text, "percent": percent, "version": env!("CARGO_PKG_VERSION")});
        if let Some(id) = self.splash_id {
            let s = self.splash_status.clone();
            self.emit(id, "splash:status", &s);
        }
    }
    /// Closes the splash once it has been on screen long enough.
    fn close_splash(&mut self) {
        let Some(id) = self.splash_id else { return };
        let wait = self.splash_shown_at.map(|t| SPLASH_MIN.saturating_sub(t.elapsed())).unwrap_or_default();
        self.later(wait, move |app, _| {
            if app.splash_id == Some(id) {
                app.splash_id = None;
                app.windows.remove(&id);
            }
        });
    }

    // ---------- Huddle's own popups ----------

    /// Shows a popup in Huddle's style and calls `then` with the index of the button pressed.
    fn show_dialog(&mut self, target: &Target, kind: &str, message: &str, detail: &str, buttons: &[&str], default_id: usize, cancel_id: Option<usize>, then: impl FnOnce(&mut App, &Target, usize) + 'static) {
        let buttons: Vec<String> = if buttons.is_empty() { vec!["OK".into()] } else { buttons.iter().map(|s| s.to_string()).collect() };
        let cancel_id = cancel_id.unwrap_or(buttons.len() - 1);
        let opts = json!({"type": kind, "message": message, "detail": detail, "buttons": buttons, "defaultId": default_id, "cancelId": cancel_id});
        let window = match WindowBuilder::new()
            .with_inner_size(LogicalSize::new(440.0, 300.0))
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_maximizable(false)
            .with_minimizable(false)
            .with_always_on_top(true)
            .with_title("Huddle")
            .with_visible(false)
            .with_window_icon(platform::icon_from_png(ui::ICON_PNG, None))
            .build(target)
        {
            Ok(w) => w,
            Err(e) => return self.logger.error(format!("Couldn't open a popup: {e}")),
        };
        let wid = window.id();
        match self.build_webview(&window, Kind::Dialog, &ui::page_url("dialog.html"), true) {
            Ok(webview) => {
                self.dialogs.insert(wid, DialogState { opts, buttons: buttons.len(), cancel_id, then: Some(Box::new(then)) });
                self.windows.insert(wid, Win { window, webview, kind: Kind::Dialog });
            }
            Err(e) => self.logger.error(format!("Couldn't draw a popup: {e}")),
        }
    }
    fn info(&mut self, target: &Target, message: &str, detail: &str) {
        self.show_dialog(target, "info", message, detail, &["OK"], 0, None, |_, _, _| {});
    }
    fn finish_dialog(&mut self, target: &Target, wid: WindowId, index: usize) {
        let then = self.dialogs.remove(&wid).and_then(|mut d| d.then.take());
        self.windows.remove(&wid);
        if let Some(then) = then {
            then(self, target, index);
        }
    }

    // ---------- automatic updates ----------

    fn init_updater(&mut self) {
        let no_auto = std::env::var("HUDDLE_NO_AUTO_UPDATE").is_ok_and(|v| !v.is_empty());
        if !can_auto_update(self.packaged, std::env::consts::OS, no_auto) {
            return;
        }
        let proxy = self.proxy.clone();
        let on_state = Arc::new(move |state: UpdateState| {
            let _ = proxy.send_event(UserEvent::Run(Box::new(move |app, t| app.on_update_state(t, state))));
        });
        self.updater = Some(Updater::new(settings::data_dir().join("updates"), env!("CARGO_PKG_VERSION"), on_state));
    }
    fn feed_url(&self) -> Option<String> {
        update_feed_url(self.server_url().as_deref())
    }
    fn on_update_state(&mut self, target: &Target, state: UpdateState) {
        self.build_menus();
        let v = serde_json::to_value(&state).unwrap_or(Value::Null);
        self.emit_main("update:state", &v);
        if self.in_startup_update && state.status == "downloading" {
            let text = format!("Downloading update{}{}", state.version.as_ref().map(|v| format!(" {v}")).unwrap_or_default(), match state.percent { Some(p) if p > 0 => format!(" · {p}%"), _ => "…".into() });
            self.set_splash(&text, state.percent);
        }
        if let Some(reminder) = self.update_notifier.consider(&state, self.quiet_now(), Instant::now()) {
            let _ = reminder;
            self.show_update_ready(target, state.version.clone().unwrap_or_default());
        }
    }
    fn show_update_ready(&mut self, target: &Target, version: String) {
        self.show_toast(target, json!({"title": format!("Huddle {version} is ready"), "body": "Restart Huddle to finish updating.", "tag": "huddle-update"}), None, Some(version));
    }
    /// Looks for updates every 45 minutes, soon after the computer wakes up or the window is opened, and again within minutes if a
    /// check fails (a free server may still be waking up).
    fn start_update_checks(&mut self) {
        let Some(updater) = self.updater.clone() else { return };
        let (shared, schedule, last, poke) = (self.shared.clone(), self.schedule, self.last_update_check.clone(), self.update_poke.clone());
        self.rt.spawn(async move {
            tokio::time::sleep(schedule.first_check).await;
            let mut failures = 0u32;
            loop {
                *last.lock().unwrap() = Some(Instant::now());
                let feed = update_feed_url(shared.server_url.lock().unwrap().as_deref());
                if let Some(feed) = feed {
                    failures = if updater.check(&feed).await.status == "error" { failures + 1 } else { 0 };
                }
                tokio::select! {
                    _ = tokio::time::sleep(schedule.next_delay(failures)) => {}
                    _ = poke.notified() => {}
                }
            }
        });
        // Reminders, and a popup held back by quiet hours.
        fn hourly(app: &mut App, t: &Target) {
            if let Some(u) = &app.updater {
                let s = u.state();
                app.on_update_state_reminder(t, s);
            }
            app.later(Duration::from_secs(3600), hourly);
        }
        self.later(Duration::from_secs(3600), hourly);
    }
    fn on_update_state_reminder(&mut self, target: &Target, state: UpdateState) {
        if self.update_notifier.consider(&state, self.quiet_now(), Instant::now()).is_some() {
            self.show_update_ready(target, state.version.clone().unwrap_or_default());
        }
    }
    /// Opening Huddle is a good moment to look for an update.
    fn poke_updates(&self) {
        let allowed = self.schedule.poke_allowed(self.last_update_check.lock().unwrap().map(|t| t.elapsed()));
        if allowed {
            self.update_poke.notify_one();
        }
    }
    fn install_update(&mut self) {
        let Some(path) = self.updater.as_ref().and_then(|u| u.ready_installer()) else { return };
        match launch_installer(&path) {
            Ok(()) => {
                self.quitting = true;
                self.should_exit = true;
            }
            Err(e) => self.logger.error(format!("Couldn't start the update installer: {e}")),
        }
    }
    fn check_now(&mut self, target: &Target) {
        let (Some(updater), Some(feed)) = (self.updater.clone(), self.feed_url()) else {
            return self.info(target, "Automatic updates aren't available for this copy of Huddle.", "Installed copies of the app update themselves.");
        };
        self.spawn(async move { updater.check(&feed).await }, |app, t, state| {
            let current = env!("CARGO_PKG_VERSION");
            match state.status.as_str() {
                "ready" => app.show_dialog(t, "info", &format!("Huddle {} is ready to install.", state.version.clone().unwrap_or_default()), "Restart Huddle to finish updating.", &["Restart now", "Later"], 0, Some(1), |app, _, i| if i == 0 { app.install_update() }),
                "downloading" => app.info(t, &format!("Downloading Huddle {}…", state.version.clone().unwrap_or_default()), "You'll get a notification when it's ready to install."),
                "error" => app.show_dialog(t, "warning", "Couldn't check for updates.", state.message.as_deref().unwrap_or(""), &["OK"], 0, None, |_, _, _| {}),
                _ => app.info(t, "You're up to date.", &format!("Huddle {current}")),
            }
        });
    }
    /// Splash step: look for an update before opening Huddle, and install it straight away if there is one.
    fn startup_update(&mut self) {
        let (Some(updater), Some(feed)) = (self.updater.clone(), self.feed_url()) else { return self.after_startup_update(false) };
        self.in_startup_update = true;
        self.set_splash("Checking for updates…", None);
        self.later(Duration::from_secs(5), |app, _| if app.in_startup_update { app.set_splash("Still checking… the server may be waking up", None) });
        self.spawn(async move { updater.startup_check(&feed).await }, |app, _, ready| {
            app.in_startup_update = false;
            if ready {
                app.set_splash("Installing update… Huddle will reopen by itself.", None);
                app.later(Duration::from_millis(1500), |app, _| app.install_update());
            } else {
                app.after_startup_update(false);
            }
        });
    }
    fn after_startup_update(&mut self, _installing: bool) {
        self.set_splash("Opening Huddle…", None);
        self.later(Duration::ZERO, |app, t| {
            if app.main_id.is_none() {
                app.create_window(t);
            }
            app.start_update_checks();
        });
    }

    // ---------- the window ----------

    fn visible_bounds(&self, target: &Target, b: Option<Bounds>) -> Option<Bounds> {
        let b = b?;
        let (x, y) = (b.x?, b.y?);
        let on_screen = target.available_monitors().any(|m| {
            let s = m.scale_factor();
            let (mp, ms) = (m.position().to_logical::<f64>(s), m.size().to_logical::<f64>(s));
            x < mp.x + ms.width - 40.0 && x + b.width > mp.x + 40.0 && y >= mp.y - 10.0 && y < mp.y + ms.height - 40.0
        });
        Some(if on_screen { b } else { Bounds { x: None, y: None, ..b } })
    }

    fn create_window(&mut self, target: &Target) {
        self.stop_background();
        let b = self.visible_bounds(target, self.settings.bounds);
        let mut wb = WindowBuilder::new()
            .with_title("Huddle")
            .with_inner_size(LogicalSize::new(b.map_or(1200.0, |b| b.width), b.map_or(800.0, |b| b.height)))
            .with_min_inner_size(LogicalSize::new(720.0, 520.0))
            .with_visible(false)
            // No native title bar: Huddle draws its own (logo menu, title) and the app adds the window buttons.
            .with_decorations(cfg!(target_os = "macos"))
            .with_window_icon(platform::icon_from_png(ui::ICON_PNG, None));
        if let Some(Bounds { x: Some(x), y: Some(y), .. }) = b {
            wb = wb.with_position(LogicalPosition::new(x, y));
        }
        #[cfg(windows)]
        {
            use tao::platform::windows::WindowBuilderExtWindows;
            wb = wb.with_undecorated_shadow(true);
        }
        let window = match wb.build(target) {
            Ok(w) => w,
            Err(e) => return self.logger.error(format!("Couldn't open the Huddle window: {e}")),
        };
        let wid = window.id();
        match self.build_webview(&window, Kind::Main, "about:blank", false) {
            Ok(webview) => {
                self.windows.insert(wid, Win { window, webview, kind: Kind::Main });
                self.main_id = Some(wid);
                self.page_ready = false;
                self.shown_once = false;
                self.load_app();
                // If the page never says it has finished loading, show the window anyway.
                self.later(Duration::from_secs(15), move |app, t| app.on_main_page_loaded(t, wid));
            }
            Err(e) => self.logger.error(format!("Couldn't draw the Huddle window: {e}")),
        }
    }

    fn on_main_page_loaded(&mut self, _target: &Target, wid: WindowId) {
        if self.main_id != Some(wid) || self.shown_once {
            return;
        }
        let Some(w) = self.windows.get(&wid) else { return };
        if w.webview.url().is_ok_and(|u| u == "about:blank") {
            return; // that was the empty first page; the real one is on its way
        }
        self.shown_once = true;
        if self.settings.maximized {
            w.window.set_maximized(true);
        }
        if self.start_hidden {
            self.start_hidden = false; // opened with the computer in the background: stay in the tray until the person opens it
            self.close_splash();
            self.arm_unload();
            return;
        }
        w.window.set_visible(true);
        w.window.set_focus();
        self.send_window_state();
        self.close_splash();
    }

    fn load_app(&mut self) {
        let Some(wid) = self.main_id else { return };
        let Some(url) = self.server_url() else { return self.show_setup(false) };
        let target = match self.initial_path.take() {
            Some(p) => url::Url::parse(&url).and_then(|b| b.join(&p)).map(|u| u.to_string()).unwrap_or(url.clone()),
            None => url.clone(),
        };
        // The page engine shows its own error page when a server can't be reached, so look first and show Huddle's instead.
        self.spawn(probe(url.clone(), Duration::from_secs(12), false), move |app, _, ok| {
            if app.main_id != Some(wid) { return; }
            if ok {
                if let Some(w) = app.windows.get(&wid) { let _ = w.webview.load_url(&target); }
            } else {
                app.show_setup(true);
            }
        });
    }
    fn show_setup(&mut self, failed: bool) {
        let url = ui::page_url(if failed { "setup.html?failed=1" } else { "setup.html" });
        if let Some(w) = self.main_window() {
            let _ = w.webview.load_url(&url);
        }
    }
    fn show_window(&mut self, target: &Target) {
        self.poke_updates();
        self.unload_gen += 1; // it's being shown: don't free it
        match self.main_window() {
            None => self.create_window(target),
            Some(w) => {
                w.window.set_minimized(false);
                w.window.set_visible(true);
                w.window.set_focus();
            }
        }
    }
    fn send_window_state(&self) {
        if let Some(w) = self.main_window() {
            let s = json!({"maximized": w.window.is_maximized(), "fullscreen": w.window.fullscreen().is_some()});
            self.emit_main("window:state", &s);
        }
    }
    fn hide_main(&mut self) {
        if let Some(w) = self.main_window() {
            w.window.set_visible(false);
        }
        self.arm_unload();
    }
    fn remember_bounds(&mut self) {
        let Some(w) = self.main_window() else { return };
        if w.window.is_minimized() || w.window.fullscreen().is_some() {
            return;
        }
        let maximized = w.window.is_maximized();
        let s = w.window.scale_factor();
        let size = w.window.inner_size().to_logical::<f64>(s);
        let pos = w.window.outer_position().ok().map(|p| p.to_logical::<f64>(s));
        self.settings.maximized = maximized;
        if !maximized {
            self.settings.bounds = Some(Bounds { x: pos.map(|p| p.x), y: pos.map(|p| p.y), width: size.width, height: size.height });
        }
        self.save_settings();
    }

    // ---------- freeing memory while hidden in the tray ----------
    // A Huddle window is a whole browser page (hundreds of MB). After it has been hidden in the tray for a few minutes it is
    // closed for real and a small connection in this process takes over: messages for you still pop up, and clicking one
    // rebuilds the page.

    fn arm_unload(&mut self) {
        self.unload_gen += 1;
        let tok = self.unload_gen;
        let hidden = self.main_window().is_some_and(|w| !w.window.is_visible() && !w.window.is_minimized());
        if !self.settings.unload_when_hidden || !hidden {
            return;
        }
        self.later(UNLOAD_AFTER, move |app, t| if app.unload_gen == tok { app.unload_window(t) });
    }
    fn unload_window(&mut self, _target: &Target) {
        let Some(wid) = self.main_id else { return };
        let hidden = self.windows.get(&wid).is_some_and(|w| !w.window.is_visible() && !w.window.is_minimized());
        let (Some(server), true) = (self.server_url(), hidden && !self.quitting && self.tray.is_some() && self.background.is_none()) else { return };
        // The sign-in cookie is read now, while the page still exists, for the stand-in connection to use.
        let cookie = self.windows[&wid].webview.cookies_for_url(&server).map(|c| c.iter().map(|c| format!("{}={}", c.name(), c.value())).collect::<Vec<_>>().join("; ")).unwrap_or_default();
        let (proxy, shared) = (self.proxy.clone(), self.shared.clone());
        let emit: Arc<dyn Fn(BgEvent) + Send + Sync> = Arc::new(move |ev| {
            let _ = proxy.send_event(UserEvent::Run(Box::new(move |app, t| app.on_background_event(t, ev))));
        });
        let get_prefs: Arc<dyn Fn() -> Prefs + Send + Sync> = Arc::new(move || Prefs::from_json(&shared.notify_prefs.lock().unwrap()));
        let bg = Arc::new(Background::new(server, cookie, get_prefs, emit));
        bg.set_idle(self.idle.as_ref().is_some_and(|i| i.is_idle()));
        let bg2 = bg.clone();
        self.spawn(async move { bg2.start(Duration::from_secs(8)).await }, move |app, t, ok| {
            // Only let go of the page once the replacement is really listening. If it can't connect (offline, signed out), keep the page.
            let still_hidden = app.main_window().is_some_and(|w| !w.window.is_visible());
            if !ok || app.quitting || !still_hidden {
                bg.stop();
                if !ok { app.arm_unload(); }
                return;
            }
            app.background = Some(bg);
            app.keep_alive = true;
            if let Some(id) = app.main_id.take() {
                app.windows.remove(&id);
            }
            app.page_ready = false;
            let _ = t;
        });
    }
    fn stop_background(&mut self) {
        self.unload_gen += 1;
        if let Some(bg) = self.background.take() {
            bg.stop();
        }
        self.keep_alive = false;
    }
    fn on_background_event(&mut self, target: &Target, ev: BgEvent) {
        match ev {
            BgEvent::Unread(n) => {
                self.unread_count = n;
                self.refresh_tray();
            }
            BgEvent::Note(note, _kind) => {
                if self.quiet_now() {
                    return;
                }
                self.show_note(target, &note);
                if Prefs::from_json(&self.shared.notify_prefs.lock().unwrap()).sound {
                    self.beep();
                }
            }
        }
    }
    fn show_note(&mut self, target: &Target, n: &Note) {
        let t = Some((n.server_id.clone(), n.channel_id.clone()));
        self.show_toast(target, json!({"title": n.title, "body": n.body, "tag": n.tag}), t, None);
    }
    /// Opens the conversation a popup was about, rebuilding the page first if it was unloaded.
    fn open_target(&mut self, target: &Target, t: Option<(String, String)>) {
        let Some((server_id, channel_id)) = t else { return self.show_window(target) };
        let ready = self.main_id.is_some();
        if !ready {
            self.pending_target = Some((server_id.clone(), channel_id.clone()));
        }
        self.show_window(target);
        if ready {
            self.emit_main("notification-click", &json!({"serverId": server_id, "channelId": channel_id}));
        }
    }

    // ---------- reply popups ----------
    // A small Huddle-styled popup in the corner of the screen: read the message, type a reply and send it, mark it read, or open it.

    fn layout_toasts(&self, target: &Target) {
        let Some(mon) = target.primary_monitor() else { return };
        let s = mon.scale_factor();
        let (l, t, r, b) = platform::work_area().unwrap_or_else(|| {
            let (p, z) = (mon.position(), mon.size());
            (p.x, p.y, p.x + z.width as i32, p.y + z.height as i32 - (48.0 * s) as i32) // no taskbar information: leave room for a typical one
        });
        let _ = (l, t);
        for (i, toast) in self.toasts.iter().enumerate() {
            if let Some(w) = self.windows.get(&toast.wid) {
                let x = (r as f64 / s) - TOAST_W;
                let y = (b as f64 / s) - TOAST_H * (i as f64 + 1.0);
                w.window.set_outer_position(LogicalPosition::new(x, y));
            }
        }
    }
    fn close_toast(&mut self, target: &Target, wid: WindowId) {
        if let Some(i) = self.toasts.iter().position(|t| t.wid == wid) {
            self.toasts.remove(i);
        }
        self.windows.remove(&wid);
        self.layout_toasts(target);
    }
    fn arm_toast(&mut self, wid: WindowId, ms: Option<u64>) {
        let Some(t) = self.toasts.iter_mut().find(|t| t.wid == wid) else { return };
        t.tok += 1;
        if t.held {
            return;
        }
        let (tok, ms) = (t.tok, ms.unwrap_or(t.ms));
        self.later(Duration::from_millis(ms), move |app, target| {
            if app.toasts.iter().any(|t| t.wid == wid && t.tok == tok) {
                app.close_toast(target, wid);
            }
        });
    }
    fn show_toast(&mut self, target: &Target, content: Value, reply_target: Option<(String, String)>, update: Option<String>) {
        let tag = text(&content["tag"], 64);
        let actions = if update.is_some() { json!([{"id": "restart", "label": "Restart now", "primary": true}, {"id": "later", "label": "Later"}]) } else { json!([]) };
        let payload = json!({"title": content["title"], "body": content["body"], "canReply": reply_target.is_some(), "actions": actions});
        if let Some(existing) = (!tag.is_empty()).then(|| self.toasts.iter().position(|t| t.tag == tag)).flatten() {
            // Another message in the same conversation: update the popup instead of stacking a new one.
            let wid = self.toasts[existing].wid;
            self.toasts[existing].target = reply_target;
            self.toasts[existing].update = update;
            self.toasts[existing].content = payload.clone();
            self.emit(wid, "toast:show", &payload);
            return self.arm_toast(wid, None);
        }
        #[allow(unused_mut)] // changed on Windows only
        let mut wb = WindowBuilder::new()
            .with_inner_size(LogicalSize::new(TOAST_W, TOAST_H))
            .with_decorations(false)
            .with_transparent(true)
            .with_resizable(false)
            .with_maximizable(false)
            .with_minimizable(false)
            .with_always_on_top(true)
            .with_focused(false) // appears without taking focus from what you're doing
            .with_title("Huddle");
        #[cfg(windows)]
        {
            use tao::platform::windows::WindowBuilderExtWindows;
            wb = wb.with_skip_taskbar(true);
        }
        let window = match wb.build(target) {
            Ok(w) => w,
            Err(e) => return self.logger.error(format!("Couldn't show a popup: {e}")),
        };
        let wid = window.id();
        match self.build_webview(&window, Kind::Toast, &ui::page_url("toast.html"), true) {
            Ok(webview) => {
                self.toast_seq += 1;
                let ms = if update.is_some() { 25_000 } else { 9_000 };
                self.toasts.insert(0, Toast { wid, tag, target: reply_target, held: false, update, content: payload, tok: 0, ms });
                self.windows.insert(wid, Win { window, webview, kind: Kind::Toast });
                if self.toasts.len() > MAX_TOASTS {
                    let oldest = self.toasts[self.toasts.len() - 1].wid;
                    self.close_toast(target, oldest);
                }
                self.layout_toasts(target);
            }
            Err(e) => self.logger.error(format!("Couldn't draw a popup: {e}")),
        }
    }

    // ---------- the tray and menus ----------

    fn create_tray(&mut self, _target: &Target) {
        let Some(icon) = tray_icon_image(false) else { return };
        match TrayIconBuilder::new().with_icon(icon).with_tooltip("Huddle").with_menu_on_left_click(false).build() {
            Ok(t) => self.tray = Some(t),
            Err(e) => self.logger.error(format!("Couldn't create the tray icon: {e}")),
        }
    }
    fn refresh_tray(&self) {
        let Some(tray) = &self.tray else { return };
        let ready = self.updater.as_ref().is_some_and(|u| u.state().is_ready());
        let tip = format!("Huddle{}{}", if self.unread_count > 0 { format!(" ({} unread)", self.unread_count) } else { String::new() }, if ready { " · update ready" } else { "" });
        let _ = tray.set_tooltip(Some(tip));
        if let Some(icon) = tray_icon_image(self.unread_count > 0) {
            let _ = tray.set_icon(Some(icon));
        }
    }
    fn update_items(&self, hide_ready: bool) -> Vec<Box<dyn muda::IsMenuItem>> {
        let s = self.updater.as_ref().map(|u| u.state());
        let mut items: Vec<Box<dyn muda::IsMenuItem>> = Vec::new();
        match s {
            Some(s) if s.is_ready() && hide_ready => {}
            Some(s) if s.is_ready() => { items.push(Box::new(PredefinedMenuItem::separator())); items.push(Box::new(MenuItem::with_id("install-update", format!("Restart to update to {}", s.version.unwrap_or_default()), true, None))); }
            Some(s) if s.status == "downloading" => { items.push(Box::new(PredefinedMenuItem::separator())); items.push(Box::new(MenuItem::with_id("noop", format!("Downloading update{}…", s.percent.filter(|p| *p > 0).map(|p| format!(" ({p}%)")).unwrap_or_default()), false, None))); }
            _ => { items.push(Box::new(PredefinedMenuItem::separator())); items.push(Box::new(MenuItem::with_id("check-updates", "Check for updates…", true, None))); }
        }
        items
    }
    fn common_items(&self) -> Vec<Box<dyn muda::IsMenuItem>> {
        let s = &self.settings;
        let check = |id: &str, label: &str, on: bool, enabled: bool| -> Box<dyn muda::IsMenuItem> { Box::new(CheckMenuItem::with_id(id, label, enabled, on, None)) };
        let trouble = Submenu::with_items("Troubleshooting", true, &[&MenuItem::with_id("copy-debug", "Copy debug info", true, None), &MenuItem::with_id("open-logs", "Open logs folder", true, None)]).unwrap();
        vec![
            check("toggle-tray", "Keep running in the tray when closed", s.close_to_tray, true),
            check("toggle-startup", "Start Huddle when I sign in to my computer", s.launch_at_startup, true),
            check("toggle-background", "Start in the background (don't show the window)", s.start_in_background, s.launch_at_startup),
            check("toggle-unload", "Free up memory when hidden in the tray", s.unload_when_hidden, true),
            Box::new(MenuItem::with_id("memory", "Memory usage…", true, None)),
            Box::new(trouble),
        ]
    }
    fn fill(menu: &Menu, items: Vec<Box<dyn muda::IsMenuItem>>) {
        for i in items {
            let _ = menu.append(i.as_ref());
        }
    }
    /// The Huddle menu: opened from the logo in the title bar.
    fn huddle_menu(&self) -> Menu {
        let m = Menu::new();
        let _ = m.append(&MenuItem::with_id("change-server", "Change server…", true, None));
        Self::fill(&m, self.common_items());
        Self::fill(&m, self.update_items(false));
        let _ = m.append(&PredefinedMenuItem::separator());
        for (id, label) in [("zoom-in", "Zoom in\tCtrl+="), ("zoom-out", "Zoom out\tCtrl+-"), ("zoom-reset", "Actual size\tCtrl+0"), ("fullscreen", "Full screen\tF11"), ("reload", "Reload\tCtrl+R"), ("devtools", "Developer tools\tF12")] {
            let _ = m.append(&MenuItem::with_id(id, label, true, None));
        }
        let _ = m.append(&PredefinedMenuItem::separator());
        let _ = m.append(&MenuItem::with_id("quit", "Quit Huddle", true, None));
        m
    }
    fn build_menus(&mut self) {
        let ready = self.updater.as_ref().map(|u| u.state());
        let m = Menu::new();
        if let Some(s) = ready.as_ref().filter(|s| s.is_ready()) {
            let _ = m.append(&MenuItem::with_id("install-update", format!("Restart to update to {}", s.version.clone().unwrap_or_default()), true, None));
            let _ = m.append(&PredefinedMenuItem::separator());
        }
        let _ = m.append(&MenuItem::with_id("open", "Open Huddle", true, None));
        Self::fill(&m, self.common_items());
        let _ = m.append(&MenuItem::with_id("change-server", "Change server…", true, None));
        Self::fill(&m, self.update_items(ready.as_ref().is_some_and(|s| s.is_ready())));
        let _ = m.append(&PredefinedMenuItem::separator());
        let _ = m.append(&MenuItem::with_id("quit", "Quit Huddle", true, None));
        if let Some(tray) = &self.tray {
            tray.set_menu(Some(Box::new(m)));
        }
        self.refresh_tray();
    }
    fn popup_huddle_menu(&self, x: f64, y: f64) {
        let Some(w) = self.main_window() else { return };
        let menu = self.huddle_menu();
        let z = 1.0; // the page's own pixels are what it measured in
        let pos = muda::dpi::Position::Logical(muda::dpi::LogicalPosition::new((x * z).max(0.0), (y * z).max(TITLEBAR_H * 0.0)));
        #[cfg(windows)]
        {
            use tao::platform::windows::WindowExtWindows;
            // SAFETY: the window handle belongs to a live window on this thread.
            unsafe { menu.show_context_menu_for_hwnd(w.window.hwnd(), Some(pos)); }
        }
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::Cast;
            use tao::platform::unix::WindowExtUnix;
            menu.show_context_menu_for_gtk_window(w.window.gtk_window().upcast_ref::<gtk::Window>(), Some(pos));
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        let _ = (menu, pos, w);
    }

    fn on_menu(&mut self, target: &Target, id: &str) {
        match id {
            "open" => self.show_window(target),
            "change-server" => { self.show_window(target); self.show_setup(false); }
            "toggle-tray" => { self.settings.close_to_tray = !self.settings.close_to_tray; self.save_settings(); self.build_menus(); }
            "toggle-startup" => { let v = !self.settings.launch_at_startup; self.set_startup(Some(v), None); }
            "toggle-background" => { let v = !self.settings.start_in_background; self.set_startup(None, Some(v)); }
            "toggle-unload" => {
                self.settings.unload_when_hidden = !self.settings.unload_when_hidden;
                self.save_settings();
                if self.settings.unload_when_hidden { self.arm_unload() } else { self.unload_gen += 1 }
                self.build_menus();
            }
            "memory" => self.show_memory(target),
            "copy-debug" => self.copy_debug_info(target),
            "open-logs" => { let _ = std::fs::create_dir_all(&self.logger.dir); if open::that(&self.logger.dir).is_err() { self.show_dialog(target, "warning", "Couldn't open the logs folder.", &self.logger.dir.display().to_string(), &["OK"], 0, None, |_, _, _| {}); } }
            "check-updates" => self.check_now(target),
            "install-update" => self.install_update(),
            "zoom-in" => self.zoom(0.5),
            "zoom-out" => self.zoom(-0.5),
            "zoom-reset" => self.zoom(0.0),
            "fullscreen" => self.toggle_fullscreen(),
            "reload" => { if let Some(w) = self.main_window() { let _ = w.webview.reload(); } }
            "devtools" => self.toggle_devtools(),
            "quit" => { self.quitting = true; self.should_exit = true; }
            _ => {}
        }
    }
    fn zoom(&mut self, delta: f64) {
        self.zoom_level = if delta == 0.0 { 0.0 } else { (self.zoom_level + delta).clamp(-3.0, 3.0) };
        if let Some(w) = self.main_window() {
            let _ = w.webview.zoom(1.2f64.powf(self.zoom_level));
        }
    }
    fn toggle_fullscreen(&self) {
        if let Some(w) = self.main_window() {
            w.window.set_fullscreen(if w.window.fullscreen().is_some() { None } else { Some(Fullscreen::Borderless(None)) });
        }
        self.send_window_state();
    }
    fn toggle_devtools(&self) {
        if let Some(w) = self.main_window() {
            if w.webview.is_devtools_open() { w.webview.close_devtools() } else { w.webview.open_devtools() }
        }
    }

    // ---------- starting with the computer ----------

    fn apply_startup(&self) {
        if !self.packaged {
            return;
        }
        let log = self.logger.clone();
        platform::apply_autostart(self.settings.launch_at_startup, self.settings.start_in_background, &move |m| log.error(m));
    }
    fn set_startup(&mut self, launch: Option<bool>, background: Option<bool>) {
        if let Some(v) = launch { self.settings.launch_at_startup = v; }
        if let Some(v) = background { self.settings.start_in_background = v; }
        self.save_settings();
        self.apply_startup();
        self.build_menus();
    }
    fn startup_state(&self) -> Value {
        json!({"supported": self.packaged, "launch": self.settings.launch_at_startup, "background": self.settings.start_in_background})
    }

    // ---------- global shortcuts ----------

    fn apply_hotkeys(&mut self) {
        if !hotkeys_supported() {
            return;
        }
        let raw = serde_json::to_value(&self.settings.hotkeys).unwrap_or(Value::Null);
        let r = self.hotkey_mgr.apply(&raw);
        let taken: Vec<&str> = r.status.iter().filter(|(_, s)| *s == "taken").map(|(a, _)| *a).collect();
        if !taken.is_empty() {
            self.logger.warn(format!("Shortcuts another program already uses: {}", taken.join(", ")));
        }
        self.hotkey_status = serde_json::to_value(&r.status).unwrap_or(Value::Null);
    }
    fn hotkey_state(&self) -> Value {
        let hk = hotkeys::sanitize_hotkeys(&serde_json::to_value(&self.settings.hotkeys).unwrap_or(Value::Null)).hotkeys;
        json!({"supported": hotkeys_supported(), "hotkeys": hk, "status": self.hotkey_status})
    }
    fn send_command(&mut self, target: &Target, name: &'static str) {
        if self.main_id.is_some() && self.page_ready {
            self.show_window(target);
            self.emit_main("command", &json!(name));
            return;
        }
        self.pending_command = Some(name);
        self.show_window(target); // makes the window if it's gone; the page asks for the command when it's ready
    }
    fn run_hotkey(&mut self, target: &Target, action: &'static str) {
        let now = Instant::now();
        if self.last_hotkey_at.get(action).is_some_and(|t| now.duration_since(*t) < Duration::from_millis(300)) {
            return; // a held key repeats; one press is one action
        }
        self.last_hotkey_at.insert(action, now);
        match action {
            "toggle" => {
                let frontmost = self.main_window().is_some_and(|w| w.window.is_visible() && !w.window.is_minimized() && w.window.is_focused());
                if frontmost { self.hide_main() } else { self.show_window(target) }
            }
            "switcher" => self.send_command(target, "switcher"),
            "unread" => {
                if self.main_id.is_some() {
                    return self.send_command(target, "unread"); // the page knows where its unread messages are
                }
                match self.background.as_ref().and_then(|b| b.next_unread_target()) {
                    Some(t) => self.open_target(target, Some(t)),
                    None => self.show_window(target),
                }
            }
            _ => {}
        }
    }

    // ---------- away from the computer ----------

    fn init_idle(&mut self) {
        let s = IdleSettings { enabled: self.settings.auto_idle, minutes: self.settings.auto_idle_minutes };
        self.idle = Some(IdleTracker::new(s, Box::new(|| user_idle::UserIdle::get_time().map(|t| t.as_seconds() as f64).unwrap_or(0.0))));
        fn tick(app: &mut App, _: &Target) {
            let changed = app.idle.as_mut().and_then(|i| i.check());
            app.idle_changed(changed);
            app.later(Duration::from_secs(15), tick);
        }
        self.later(Duration::from_secs(15), tick);
    }
    fn idle_changed(&mut self, changed: Option<bool>) {
        let Some(idle) = changed else { return };
        if let Some(bg) = &self.background {
            bg.set_idle(idle);
        }
        self.emit_main("idle:change", &json!(idle));
    }
    fn idle_state(&self) -> Value {
        json!({"enabled": self.settings.auto_idle, "minutes": self.settings.auto_idle_minutes, "idle": self.idle.as_ref().is_some_and(|i| i.is_idle())})
    }

    // ---------- troubleshooting ----------

    fn memory_mb(&self) -> u64 {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        let me = sysinfo::get_current_pid().unwrap_or(Pid::from(0));
        let ours = |mut pid: Pid| {
            for _ in 0..8 {
                if pid == me { return true; }
                match sys.process(pid).and_then(|p| p.parent()) { Some(p) => pid = p, None => return false }
            }
            false
        };
        sys.processes().iter().filter(|(pid, _)| ours(**pid)).map(|(_, p)| p.memory()).sum::<u64>() / (1024 * 1024)
    }
    fn show_memory(&mut self, target: &Target) {
        let mb = self.memory_mb();
        let loaded = self.main_id.is_some();
        self.info(target, &format!("Huddle is using about {mb} MB"), &format!("{}\nThis counts Huddle and the web view it starts.", if loaded { "The Huddle page is loaded." } else { "The Huddle page is unloaded to save memory." }));
    }
    fn copy_debug_info(&mut self, target: &Target) {
        let u = self.updater.as_ref().map(|u| u.state());
        let info = DebugInfo {
            app_version: env!("CARGO_PKG_VERSION").into(), packaged: self.packaged, platform: std::env::consts::OS.into(), arch: std::env::consts::ARCH.into(),
            os_version: sysinfo::System::long_os_version().unwrap_or_default(), webview: wry::webview_version().unwrap_or_else(|_| "web view unknown".into()),
            server_url: self.server_url(), uptime_seconds: self.started.elapsed().as_secs(),
            update_status: u.as_ref().map_or("unavailable".into(), |s| s.status.clone()), update_version: u.as_ref().and_then(|s| s.version.clone()), update_message: u.as_ref().and_then(|s| s.message.clone()),
            memory_mb: Some(self.memory_mb()), page_loaded: self.main_id.is_some(), close_to_tray: self.settings.close_to_tray, launch_at_startup: self.settings.launch_at_startup,
            start_in_background: self.settings.start_in_background, unload_when_hidden: self.settings.unload_when_hidden, crash_reports: 0, log_tail: self.logger.tail(25),
        };
        let copied = arboard::Clipboard::new().and_then(|mut c| c.set_text(format_debug_info(&info))).is_ok();
        if copied {
            self.info(target, "Debug info copied.", "Paste it wherever you're asking for help. It has versions, settings and the latest log lines, but no messages, passwords or sign-in details.");
        } else {
            self.show_dialog(target, "warning", "Couldn't copy to the clipboard.", "", &["OK"], 0, None, |_, _, _| {});
        }
    }

    // ---------- links and launch commands ----------

    pub fn handle_launch(&mut self, target: &Target, args: &[String]) {
        let a = parse_launch_args(args);
        if a.quit {
            self.quitting = true;
            self.should_exit = true;
            return;
        }
        if a.check_updates {
            self.show_window(target);
            return self.check_now(target);
        }
        match invite_path(&a.deep_link) {
            Some(page) => self.open_server_page(target, &page),
            None => self.show_window(target),
        }
    }
    fn open_server_page(&mut self, target: &Target, page: &str) {
        let Some(base) = self.server_url() else { return self.show_window(target) };
        if self.main_id.is_none() {
            self.initial_path = Some(page.to_string()); // the window was closed for real: it opens straight on this page
            return self.show_window(target);
        }
        self.show_window(target);
        if let (Some(w), Ok(u)) = (self.main_window(), url::Url::parse(&base).and_then(|b| b.join(page))) {
            let _ = w.webview.load_url(u.as_str());
        }
    }

    // ---------- events ----------

    pub fn on_tray(&mut self, target: &Target, e: TrayIconEvent) {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = e {
            self.show_window(target);
        }
    }
    pub fn on_hotkey(&mut self, target: &Target, action: &'static str) {
        self.run_hotkey(target, action);
    }
    pub fn on_menu_event(&mut self, target: &Target, e: MenuEvent) {
        self.on_menu(target, &e.id.0);
    }

    pub fn on_window_event(&mut self, target: &Target, wid: WindowId, event: WindowEvent) {
        let Some(kind) = self.windows.get(&wid).map(|w| w.kind) else { return };
        match (kind, event) {
            (Kind::Main, WindowEvent::CloseRequested) => {
                if self.quitting || !self.settings.close_to_tray {
                    self.quitting = true;
                    self.should_exit = true;
                } else {
                    self.hide_main();
                }
            }
            (Kind::Main, WindowEvent::Resized(_)) | (Kind::Main, WindowEvent::Moved(_)) => {
                self.remember_bounds();
                self.send_window_state();
            }
            (Kind::Main, WindowEvent::Focused(true)) => {
                if let Some(w) = self.main_window() { w.window.request_user_attention(None); }
            }
            (Kind::Dialog, WindowEvent::CloseRequested) => {
                let cancel = self.dialogs.get(&wid).map_or(0, |d| d.cancel_id);
                self.finish_dialog(target, wid, cancel);
            }
            (Kind::Toast, WindowEvent::CloseRequested) => self.close_toast(target, wid),
            (Kind::Splash, WindowEvent::CloseRequested) => { self.splash_id = None; self.windows.remove(&wid); }
            _ => {}
        }
    }

    pub fn shutdown(&mut self) {
        self.flush_settings();
        self.stop_background();
        self.hotkey_mgr.stop();
    }

    // ---------- messages from pages ----------

    pub fn on_ipc(&mut self, target: &Target, wid: WindowId, uri: &str, body: &str) {
        let Some(kind) = self.windows.get(&wid).map(|w| w.kind) else { return };
        let Ok(msg) = serde_json::from_str::<Value>(body) else { return };
        let cmd = msg["cmd"].as_str().unwrap_or("").to_string();
        let id = msg["id"].as_u64();
        let args = msg.get("args").cloned().unwrap_or(Value::Null);
        let reply = |app: &App, v: Value| { if let Some(id) = id { app.resolve(wid, id, v); } };
        match kind {
            Kind::Splash => { if ui::is_page(uri, "splash.html") && cmd == "splash:ready" { let s = self.splash_status.clone(); self.emit(wid, "splash:status", &s); } }
            Kind::Dialog => { if ui::is_page(uri, "dialog.html") { self.on_dialog_ipc(target, wid, &cmd, &args); } }
            Kind::Toast => { if ui::is_page(uri, "toast.html") { self.on_toast_ipc(target, wid, &cmd, &args, id); } }
            Kind::Main => {
                if ui::is_page(uri, "setup.html") {
                    return self.on_setup_ipc(target, wid, &cmd, &args, id);
                }
                // Only Huddle's own page (the server's address) may use the rest.
                if !same_origin(uri, self.server_url().as_deref()) {
                    return reply(self, Value::Null);
                }
                self.on_huddle_ipc(target, wid, &cmd, &args, id);
            }
        }
    }

    fn on_dialog_ipc(&mut self, target: &Target, wid: WindowId, cmd: &str, args: &Value) {
        match cmd {
            "dialog:ready" => { if let Some(d) = self.dialogs.get(&wid) { let o = d.opts.clone(); self.emit(wid, "dialog:show", &o); } }
            "dialog:choose" => {
                if let (Some(i), Some(d)) = (args.as_u64(), self.dialogs.get(&wid)) {
                    if (i as usize) < d.buttons { self.finish_dialog(target, wid, i as usize); }
                }
            }
            "dialog:size" => {
                if let (Some(h), Some(w)) = (args.as_f64(), self.windows.get(&wid)) {
                    w.window.set_inner_size(LogicalSize::new(440.0, h.round().clamp(140.0, 600.0)));
                    center(&w.window, target);
                    w.window.set_visible(true);
                    w.window.set_focus();
                }
            }
            _ => {}
        }
    }

    fn on_toast_ipc(&mut self, target: &Target, wid: WindowId, cmd: &str, args: &Value, id: Option<u64>) {
        let Some(i) = self.toasts.iter().position(|t| t.wid == wid) else { return };
        match cmd {
            "toast:ready" => {
                let c = self.toasts[i].content.clone();
                self.emit(wid, "toast:show", &c);
                self.arm_toast(wid, None);
            }
            "toast:close" => self.close_toast(target, wid),
            "toast:action" => {
                if self.toasts[i].update.is_none() { return; }
                match args.as_str() {
                    Some("restart") => { self.close_toast(target, wid); self.install_update(); }
                    Some("later") => { self.update_notifier.snooze(Instant::now()); self.close_toast(target, wid); }
                    _ => {}
                }
            }
            "toast:hold" => {
                self.toasts[i].held = args.as_bool().unwrap_or(false);
                if self.toasts[i].held { self.toasts[i].tok += 1 } else { self.arm_toast(wid, Some(4000)) }
            }
            "toast:open" => { let t = self.toasts[i].target.clone(); self.open_target(target, t); self.close_toast(target, wid); }
            "toast:markread" => {
                if let Some((server_id, channel_id)) = self.toasts[i].target.clone() {
                    self.emit_main("notification-markread", &json!({"serverId": server_id, "channelId": channel_id}));
                    if let Some(bg) = &self.background { bg.mark_read(&channel_id); }
                }
                self.close_toast(target, wid);
            }
            "toast:reply" => self.toast_reply(wid, id, text(args, 2000).trim().to_string()),
            _ => {}
        }
    }

    /// Replying: the popup hands the text to the Huddle page, which sends it with the person's own session, then says how it went.
    fn toast_reply(&mut self, wid: WindowId, id: Option<u64>, body: String) {
        let Some(id) = id else { return };
        let Some(t) = self.toasts.iter().find(|t| t.wid == wid) else { return };
        let Some((server_id, channel_id)) = t.target.clone() else { return self.resolve(wid, id, json!({"ok": false, "error": "Nothing to send."})) };
        if body.is_empty() {
            return self.resolve(wid, id, json!({"ok": false, "error": "Nothing to send."}));
        }
        if self.main_id.is_none() {
            // The page is unloaded: send the message straight from here with the saved sign-in.
            let (Some(bg), Some(server)) = (self.background.clone(), self.server_url()) else { return self.resolve(wid, id, json!({"ok": false, "error": "Couldn't reach Huddle."})) };
            let (cookie, ch) = (bg.cookie(), channel_id.clone());
            self.spawn(async move { post_reply(&server, &cookie, &ch, &body).await }, move |app, target, result| {
                if result.0 {
                    if let Some(bg) = &app.background { bg.mark_read(&channel_id); }
                    app.later(Duration::from_millis(1100), move |app, t| app.close_toast(t, wid));
                }
                let _ = target;
                app.resolve(wid, id, json!({"ok": result.0, "error": result.1}));
            });
            return;
        }
        self.reply_seq += 1;
        let rid = self.reply_seq;
        self.pending_replies.insert(rid, (wid, id));
        self.emit_main("notification-reply", &json!({"id": rid, "target": {"serverId": server_id, "channelId": channel_id}, "text": body}));
        self.later(Duration::from_secs(12), move |app, _| {
            if let Some((wid, id)) = app.pending_replies.remove(&rid) {
                app.resolve(wid, id, json!({"ok": false, "error": "That took too long. Try again."}));
            }
        });
    }

    fn on_setup_ipc(&mut self, target: &Target, wid: WindowId, cmd: &str, args: &Value, id: Option<u64>) {
        match cmd {
            "setup:current" => { if let Some(id) = id { self.resolve(wid, id, json!(self.server_url())); } }
            "setup:retry" => self.load_app(),
            "setup:change" => self.show_setup(false),
            "setup:save" => {
                let Some(id) = id else { return };
                let Some(url) = args.as_str().and_then(normalize_server_url) else {
                    return self.resolve(wid, id, json!({"error": "That doesn't look like a valid address. It should start with https://, like https://huddle.example.com."}));
                };
                let u = url.clone();
                self.spawn(async move { probe(u, Duration::from_secs(8), true).await }, move |app, t, ok| {
                    if !ok {
                        return app.resolve(wid, id, json!({"error": format!("Couldn't find a Huddle server at {url}. Check the address and your connection.")}));
                    }
                    app.settings.server_url = Some(url.clone());
                    *app.shared.server_url.lock().unwrap() = Some(url);
                    app.save_settings();
                    app.load_app();
                    app.resolve(wid, id, json!({"ok": true}));
                    if let (Some(u), Some(feed)) = (app.updater.clone(), app.feed_url()) {
                        app.rt.spawn(async move { u.check(&feed).await });
                    }
                    let _ = t;
                });
            }
            _ => {}
        }
        let _ = target;
    }

    fn on_huddle_ipc(&mut self, target: &Target, wid: WindowId, cmd: &str, args: &Value, id: Option<u64>) {
        let answer = |app: &App, v: Value| { if let Some(id) = id { app.resolve(wid, id, v); } };
        match cmd {
            "menu:popup" => self.popup_huddle_menu(args["x"].as_f64().unwrap_or(0.0), args["y"].as_f64().unwrap_or(TITLEBAR_H)),
            "win:minimize" => { if let Some(w) = self.main_window() { w.window.set_minimized(true); } }
            "win:toggle-maximize" => { if let Some(w) = self.main_window() { w.window.set_maximized(!w.window.is_maximized()); } self.send_window_state(); }
            "win:close" => { if let Some(w) = self.main_window() { let _ = w; } self.on_window_event(target, wid, WindowEvent::CloseRequested); }
            "win:drag" => { if let Some(w) = self.main_window() { let _ = w.window.drag_window(); } }
            "win:resize" => {
                if let (Some(w), Some(d)) = (self.main_window(), args.as_str().and_then(resize_direction)) { let _ = w.window.drag_resize_window(d); }
            }
            "win:fullscreen" => self.toggle_fullscreen(),
            "zoom" => self.zoom(args.as_f64().unwrap_or(0.0).clamp(-0.5, 0.5)),
            "devtools" => self.toggle_devtools(),
            "reload" => { if let Some(w) = self.main_window() { let _ = w.webview.reload(); } }
            "notify" => self.on_notify(target, args),
            "badge" => {
                let count = args["count"].as_u64().filter(|c| *c > 0).map_or(0, |c| c.min(9999)) as usize;
                #[cfg(windows)]
                if let Some(w) = self.main_window() {
                    use tao::platform::windows::WindowExtWindows;
                    let icon = if count > 0 { args["iconDataUrl"].as_str().and_then(platform::icon_from_data_url) } else { None };
                    w.window.set_overlay_icon(icon.as_ref());
                }
                self.unread_count = count;
                self.refresh_tray();
            }
            "progress:set" => {
                if let (Some(w), Some(f)) = (self.main_window(), args.as_f64().filter(|f| f.is_finite())) {
                    w.window.set_progress_bar(if f < 0.0 { ProgressBarState { progress: None, state: Some(ProgressState::None), desktop_filename: None } } else { ProgressBarState { progress: Some((f.min(1.0) * 100.0) as u64), state: Some(ProgressState::Normal), desktop_filename: None } });
                }
            }
            "update:state" => answer(self, self.updater.as_ref().map_or(json!({"status": "unsupported"}), |u| serde_json::to_value(u.state()).unwrap_or(Value::Null))),
            "update:check" => match (self.updater.clone(), self.feed_url(), id) {
                (Some(u), Some(feed), Some(id)) => self.spawn(async move { u.check(&feed).await }, move |app, _, s| app.resolve(wid, id, serde_json::to_value(s).unwrap_or(Value::Null))),
                _ => answer(self, Value::Null),
            },
            "update:install" => self.install_update(),
            "update-info" => {
                let v = json!({"version": env!("CARGO_PKG_VERSION"), "justUpdatedFrom": self.just_updated_from.take()});
                answer(self, v);
            }
            "startup:get" => answer(self, self.startup_state()),
            "startup:set" => {
                if args.is_object() { self.set_startup(args["launch"].as_bool(), args["background"].as_bool()); }
                answer(self, self.startup_state());
            }
            "hotkeys:get" => answer(self, self.hotkey_state()),
            "hotkeys:set" => {
                if hotkeys_supported() && args.is_object() {
                    self.hotkey_pause_gen += 1;
                    let r = self.hotkey_mgr.apply(args);
                    self.settings.hotkeys = r.hotkeys.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
                    self.hotkey_status = serde_json::to_value(&r.status).unwrap_or(Value::Null);
                    self.save_settings();
                }
                answer(self, self.hotkey_state());
            }
            // While the person is pressing keys to choose a shortcut, the current ones must not fire: pause them (and never leave them paused).
            "hotkeys:pause" => {
                if !hotkeys_supported() { return; }
                self.hotkey_pause_gen += 1;
                if args.as_bool() == Some(true) {
                    self.hotkey_mgr.stop();
                    let tok = self.hotkey_pause_gen;
                    self.later(Duration::from_secs(30), move |app, _| if app.hotkey_pause_gen == tok { app.apply_hotkeys() });
                } else {
                    self.apply_hotkeys();
                }
            }
            "idle:get" => answer(self, self.idle_state()),
            "idle:set" => {
                if args.is_object() {
                    let cur = IdleSettings { enabled: self.settings.auto_idle, minutes: self.settings.auto_idle_minutes };
                    let next = sanitize_idle_settings(args, cur);
                    self.settings.auto_idle = next.enabled;
                    self.settings.auto_idle_minutes = next.minutes;
                    self.save_settings();
                    let changed = self.idle.as_mut().and_then(|i| i.configure(next));
                    self.idle_changed(changed);
                    answer(self, self.idle_state());
                } else {
                    answer(self, Value::Null);
                }
            }
            "reply-result" => {
                if let Some(rid) = args["id"].as_u64() {
                    if let Some((twid, tid)) = self.pending_replies.remove(&rid) {
                        let ok = args["ok"].as_bool().unwrap_or(false);
                        self.resolve(twid, tid, json!({"ok": ok, "error": text(&args["error"], 120)}));
                        if ok { self.later(Duration::from_millis(1100), move |app, t| app.close_toast(t, twid)); }
                    }
                }
            }
            "notify-prefs" => {
                if !args.is_object() { return; }
                let p = Prefs::from_json(args);
                let out = json!({"enabled": p.enabled, "sound": p.sound, "preview": p.preview, "dms": p.dms, "mentions": p.mentions, "everyone": p.everyone, "quiet": sanitize_quiet(&args["quiet"]).to_json()});
                *self.shared.notify_prefs.lock().unwrap() = out.clone();
                self.settings.notify_prefs = Some(out);
                self.save_settings();
            }
            // The page has set up its listeners: hand over a click or a shortcut that happened while it was gone.
            "page-ready" => {
                self.page_ready = true;
                if let Some((s, c)) = self.pending_target.take() {
                    self.emit(wid, "notification-click", &json!({"serverId": s, "channelId": c}));
                }
                if let Some(cmd) = self.pending_command.take() {
                    self.emit(wid, "command", &json!(cmd));
                }
            }
            _ => {}
        }
    }

    fn on_notify(&mut self, target: &Target, n: &Value) {
        let title = text(&n["title"], 100);
        if title.is_empty() { return; }
        if self.quiet_now() && n["tag"].as_str() != Some("huddle-test") { return; } // quiet hours, except the "Send a test" button, which should always answer
        let t = &n["target"];
        let reply_target = (is_uuid(&t["serverId"]) && is_uuid(&t["channelId"])).then(|| (t["serverId"].as_str().unwrap().to_string(), t["channelId"].as_str().unwrap().to_string()));
        self.show_toast(target, json!({"title": title, "body": text(&n["body"], 250), "tag": text(&n["tag"], 64)}), reply_target, None);
        if let Some(w) = self.main_window() {
            if !w.window.is_focused() { w.window.request_user_attention(Some(UserAttentionType::Informational)); }
        }
    }
}

// ---------- free helpers ----------

fn hotkeys_supported() -> bool {
    // Wayland doesn't allow global shortcuts.
    !(cfg!(target_os = "linux") && std::env::var("XDG_SESSION_TYPE").is_ok_and(|v| v == "wayland"))
}

/// Huddle needs no browser-style permissions: camera, microphone, location, notifications and clipboard reading are all refused.
/// (Copying to the clipboard and going fullscreen aren't permission requests in this web view, so they keep working.)
fn permission_response(_kind: &wry::PermissionKind) -> wry::PermissionResponse {
    wry::PermissionResponse::Deny
}

fn tray_icon_image(unread: bool) -> Option<tray_icon::Icon> {
    let png = if unread { ui::TRAY_UNREAD_PNG } else { ui::TRAY_PNG };
    let (rgba, w, h) = platform::rgba_from_png(png, Some(20))?;
    tray_icon::Icon::from_rgba(rgba, w, h).ok()
}

fn resize_direction(name: &str) -> Option<tao::window::ResizeDirection> {
    use tao::window::ResizeDirection as D;
    Some(match name {
        "North" => D::North, "South" => D::South, "East" => D::East, "West" => D::West,
        "NorthEast" => D::NorthEast, "NorthWest" => D::NorthWest, "SouthEast" => D::SouthEast, "SouthWest" => D::SouthWest,
        _ => return None,
    })
}

fn center(window: &Window, target: &Target) {
    if let Some(m) = window.current_monitor().or_else(|| target.primary_monitor()) {
        let (mp, ms, ws) = (m.position(), m.size(), window.outer_size());
        window.set_outer_position(tao::dpi::PhysicalPosition::new(mp.x + (ms.width as i32 - ws.width as i32) / 2, mp.y + (ms.height as i32 - ws.height as i32) / 2));
    }
}

/// Is there a Huddle server at `origin`? (`strict` also wants the exact "ok" Huddle answers with.)
async fn probe(origin: String, timeout: Duration, strict: bool) -> bool {
    let Ok(client) = reqwest::Client::builder().timeout(timeout).build() else { return false };
    match client.get(format!("{origin}/healthz")).send().await {
        Ok(r) if r.status().is_success() => !strict || r.text().await.is_ok_and(|t| t.trim() == "ok"),
        _ => false,
    }
}

async fn post_reply(server: &str, cookie: &str, channel_id: &str, body: &str) -> (bool, String) {
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).build() else { return (false, "Couldn't reach Huddle.".into()) };
    match client.post(format!("{server}/api/channels/{channel_id}/messages")).header("cookie", cookie).json(&json!({"content": body})).send().await {
        Ok(r) if r.status().is_success() => (true, String::new()),
        Ok(r) => {
            let msg = r.json::<Value>().await.ok().and_then(|v| v["error"].as_str().map(|s| s.chars().take(120).collect::<String>()));
            (false, msg.filter(|m| !m.is_empty()).unwrap_or_else(|| "Couldn't send.".into()))
        }
        Err(_) => (false, "Couldn't reach Huddle.".into()),
    }
}

fn build_in_window(b: WebViewBuilder, window: &Window) -> Result<WebView, String> {
    #[cfg(target_os = "linux")]
    {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().ok_or("the window has no place for a web view")?;
        b.build_gtk(vbox).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        b.build(window).map_err(|e| e.to_string())
    }
}

/// Builds the event loop and runs the app. Never returns.
pub fn run(rt: tokio::runtime::Runtime, logger: Arc<Logger>, listener: Option<interprocess::local_socket::Listener>, args: Vec<String>) -> ! {
    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let mut app = App::new(&event_loop, rt.handle().clone(), logger, listener.is_some());
    if let Some(l) = listener {
        let proxy = event_loop.create_proxy();
        platform::listen(l, move |argv| {
            let _ = proxy.send_event(UserEvent::Run(Box::new(move |app, t| app.handle_launch(t, &argv))));
        });
    }
    let mut first_args = Some(args);
    event_loop.run(move |event, target, flow| {
        let _keep_runtime_alive = &rt;
        *flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => app.start(target, &first_args.take().unwrap_or_default()),
            Event::UserEvent(UserEvent::Run(job)) => job(&mut app, target),
            Event::UserEvent(UserEvent::Ipc { wid, uri, body }) => app.on_ipc(target, wid, &uri, &body),
            Event::UserEvent(UserEvent::Tray(e)) => app.on_tray(target, e),
            Event::UserEvent(UserEvent::Menu(e)) => app.on_menu_event(target, e),
            Event::UserEvent(UserEvent::Hotkey(a)) => app.on_hotkey(target, a),
            Event::WindowEvent { window_id, event, .. } => app.on_window_event(target, window_id, event),
            Event::LoopDestroyed => app.shutdown(),
            _ => {}
        }
        if app.should_exit {
            *flow = ControlFlow::Exit;
        }
    })
}
