//! A tiny stand-in for the Huddle page while the window is unloaded to save memory.
//! It keeps one connection to the server so direct messages, @mentions and @everyone still pop up (and the tray dot still
//! lights), then the page is rebuilt when you open Huddle.
use crate::quiet::{sanitize_quiet, Quiet};
use regex::Regex;
use rust_socketio::{client::Client, Event, Payload, TransportType};
use rust_socketio::ClientBuilder;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

/// The person's notification choices (copied from the page, see "notify-prefs").
#[derive(Debug, Clone, PartialEq)]
pub struct Prefs {
    pub enabled: bool,
    pub sound: bool,
    pub preview: bool,
    pub dms: bool,
    pub mentions: bool,
    pub everyone: bool,
    pub quiet: Quiet,
}

impl Default for Prefs {
    fn default() -> Self {
        Prefs { enabled: true, sound: true, preview: true, dms: true, mentions: true, everyone: true, quiet: Quiet::default() }
    }
}

impl Prefs {
    /// Missing or wrongly-typed keys fall back to the defaults.
    pub fn from_json(v: &Value) -> Prefs {
        let d = Prefs::default();
        let b = |k: &str, fallback: bool| v.get(k).and_then(Value::as_bool).unwrap_or(fallback);
        Prefs { enabled: b("enabled", d.enabled), sound: b("sound", d.sound), preview: b("preview", d.preview), dms: b("dms", d.dms), mentions: b("mentions", d.mentions), everyone: b("everyone", d.everyone), quiet: sanitize_quiet(v.get("quiet").unwrap_or(&Value::Null)) }
    }
}

/// What the stand-in knows about the person, to decide what concerns them.
#[derive(Debug, Default)]
pub struct Ctx {
    pub me_id: String,
    pub presence: String,
    pub dm_ids: HashSet<String>,
    pub server_names: HashMap<String, String>,
    pub prefs: Prefs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Dm,
    Mention,
    Everyone,
}

fn str_of<'a>(m: &'a Value, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str)
}

/// Which kind of message is this for me? None when it shouldn't notify at all.
pub fn classify(m: &Value, ctx: &Ctx) -> Option<Kind> {
    if !m.is_object() || str_of(m, "authorId") == Some(ctx.me_id.as_str()) {
        return None;
    }
    if ctx.presence == "dnd" || !ctx.prefs.enabled {
        return None; // Do not disturb: nothing pops up
    }
    let p = &ctx.prefs;
    if str_of(m, "serverId").is_some_and(|s| ctx.dm_ids.contains(s)) {
        return p.dms.then_some(Kind::Dm);
    }
    if m.get("mentions").and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(ctx.me_id.as_str()))) {
        return p.mentions.then_some(Kind::Mention);
    }
    if m.get("mentionsEveryone").and_then(Value::as_bool) == Some(true) {
        return p.everyone.then_some(Kind::Everyone);
    }
    None
}

static EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<a?:(\w+):[\w-]+>").unwrap());
static SPOILER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\|\|[^|]*\|\|").unwrap());

/// A readable one-line version of a message: custom emoji become :name:, spoilers are hidden, spaces are tidied.
pub fn plain(text: &str) -> String {
    let t = EMOJI.replace_all(text, ":$1:");
    let t = SPOILER.replace_all(&t, "[spoiler]");
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
    pub tag: String,
    pub server_id: String,
    pub channel_id: String,
}

/// What the popup should say, matching what the page itself would have shown.
pub fn build_note(m: &Value, kind: Kind, ctx: &Ctx) -> Note {
    let has_attachments = m.get("attachments").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
    let truthy = |k: &str| m.get(k).is_some_and(|v| !v.is_null() && v != &json!(false) && v != &json!("") && v != &json!(0));
    let fallback = if truthy("gif") { "Sent a GIF" } else if has_attachments { "Sent an attachment" } else if truthy("poll") { "Started a poll" } else { "New message" };
    let text = plain(str_of(m, "content").unwrap_or(""));
    let text = if text.is_empty() { fallback.to_string() } else { text };
    let body = if ctx.prefs.preview {
        text.chars().take(160).collect()
    } else if kind == Kind::Dm {
        "Sent you a message".to_string()
    } else {
        "Mentioned you".to_string()
    };
    let server_id = str_of(m, "serverId").unwrap_or("").to_string();
    let where_ = ctx.server_names.get(&server_id).map(String::as_str).unwrap_or("a server");
    let author = str_of(m, "authorName").unwrap_or("Someone");
    let channel_id = str_of(m, "channelId").unwrap_or("").to_string();
    Note {
        title: if kind == Kind::Dm { author.to_string() } else { format!("{author} in {where_}") },
        body,
        tag: channel_id.clone(),
        server_id,
        channel_id,
    }
}

/// Unread messages for me, per conversation, oldest first.
#[derive(Debug, Default)]
pub struct Unread {
    items: Vec<(String, u32, String)>, // channel id, how many, the server (or conversation) it belongs to
}

impl Unread {
    pub fn add(&mut self, channel: &str, server: &str) {
        match self.items.iter_mut().find(|i| i.0 == channel) {
            Some(i) => { i.1 += 1; i.2 = server.to_string(); }
            None => self.items.push((channel.to_string(), 1, server.to_string())),
        }
    }
    pub fn total(&self) -> usize { self.items.iter().map(|i| i.1 as usize).sum() }
    pub fn mark_read(&mut self, channel: &str) { self.items.retain(|i| i.0 != channel); }
    pub fn clear(&mut self) { self.items.clear(); }
    /// Where the oldest unread message is, as (server id, channel id), or None if there is none.
    pub fn next_target(&self) -> Option<(String, String)> {
        self.items.iter().find(|i| i.1 > 0 && !i.2.is_empty()).map(|i| (i.2.clone(), i.0.clone()))
    }
}

/// What the connection reports to the app.
pub enum BgEvent {
    Note(Note, Kind),
    Unread(usize),
}

pub struct Background {
    origin: String,
    cookie: String,
    http: reqwest::Client,
    pub ctx: Arc<Mutex<Ctx>>,
    unread: Arc<Mutex<Unread>>,
    socket: Arc<Mutex<Option<Client>>>,
    connected: Arc<Mutex<bool>>,
    idle: Arc<Mutex<bool>>,
    get_prefs: Arc<dyn Fn() -> Prefs + Send + Sync>,
    emit: Arc<dyn Fn(BgEvent) + Send + Sync>,
}

impl Background {
    /// `cookie` is the sign-in cookie header taken from the page just before it was closed.
    pub fn new(origin: String, cookie: String, get_prefs: Arc<dyn Fn() -> Prefs + Send + Sync>, emit: Arc<dyn Fn(BgEvent) + Send + Sync>) -> Self {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(10)).build().unwrap_or_default();
        let ctx = Ctx { presence: "online".into(), prefs: get_prefs(), ..Default::default() };
        Background { origin, cookie, http, ctx: Arc::new(Mutex::new(ctx)), unread: Arc::default(), socket: Arc::default(), connected: Arc::default(), idle: Arc::default(), get_prefs, emit }
    }

    async fn get(http: &reqwest::Client, origin: &str, cookie: &str, path: &str) -> Result<Value, String> {
        let r = http.get(format!("{origin}{path}")).header("cookie", cookie).send().await.map_err(|e| e.without_url().to_string())?;
        if !r.status().is_success() {
            return Err(format!("{path}: {}", r.status()));
        }
        r.json().await.map_err(|e| e.without_url().to_string())
    }

    /// The computer went idle or came back. Tells the server now if connected, and again after any reconnect.
    pub fn set_idle(&self, idle: bool) {
        *self.idle.lock().unwrap() = idle;
        if *self.connected.lock().unwrap() {
            if let Some(s) = self.socket.lock().unwrap().as_ref() {
                let _ = s.emit("presence.auto", json!({ "idle": idle }));
            }
        }
    }

    fn refresh_lists(http: reqwest::Client, origin: String, cookie: String, ctx: Arc<Mutex<Ctx>>) {
        tokio::spawn(async move {
            if let Ok(r) = Self::get(&http, &origin, &cookie, "/api/servers").await {
                let names = r["servers"].as_array().map(|a| a.iter().filter_map(|s| Some((s["id"].as_str()?.to_string(), s["name"].as_str()?.to_string()))).collect()).unwrap_or_default();
                ctx.lock().unwrap().server_names = names;
            }
            if let Ok(r) = Self::get(&http, &origin, &cookie, "/api/dms").await {
                let ids = r["dms"].as_array().map(|a| a.iter().filter_map(|d| d["id"].as_str().map(String::from)).collect()).unwrap_or_default();
                ctx.lock().unwrap().dm_ids = ids;
            }
        });
    }

    /// Connects. Resolves true once it's listening, false if it couldn't (signed out, offline) so the page should stay.
    pub async fn start(&self, timeout: Duration) -> bool {
        let (origin, cookie, http) = (self.origin.clone(), self.cookie.clone(), self.http.clone());
        let (me, dms, servers) = tokio::join!(
            Self::get(&http, &origin, &cookie, "/api/auth/me"),
            Self::get(&http, &origin, &cookie, "/api/dms"),
            Self::get(&http, &origin, &cookie, "/api/servers")
        );
        let (Ok(me), Ok(dms), Ok(servers)) = (me, dms, servers) else { return false };
        {
            let mut c = self.ctx.lock().unwrap();
            let Some(id) = me["user"]["id"].as_str() else { return false };
            c.me_id = id.to_string();
            c.presence = me["user"]["presence"].as_str().unwrap_or("online").to_string();
            c.dm_ids = dms["dms"].as_array().map(|a| a.iter().filter_map(|d| d["id"].as_str().map(String::from)).collect()).unwrap_or_default();
            c.server_names = servers["servers"].as_array().map(|a| a.iter().filter_map(|s| Some((s["id"].as_str()?.to_string(), s["name"].as_str()?.to_string()))).collect()).unwrap_or_default();
        }

        let (ctx, unread, emit, get_prefs) = (self.ctx.clone(), self.unread.clone(), self.emit.clone(), self.get_prefs.clone());
        let (connected, idle_flag, socket_slot) = (self.connected.clone(), self.idle.clone(), self.socket.clone());
        let connected_on_close = self.connected.clone();
        let (ctx_c, http_c, origin_c, cookie_c) = (self.ctx.clone(), self.http.clone(), self.origin.clone(), self.cookie.clone());
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = Arc::new(Mutex::new(Some(tx)));
        let origin_for_socket = self.origin.clone();
        let cookie_hdr = self.cookie.clone();
        let handle = tokio::task::spawn_blocking(move || {
            ClientBuilder::new(origin_for_socket)
                .transport_type(TransportType::Websocket)
                .opening_header("cookie", cookie_hdr)
                .reconnect(true)
                .reconnect_on_disconnect(true)
                .reconnect_delay(1000, 30_000)
                .max_reconnect_attempts(255)
                .on(Event::Connect, move |_, client| {
                    *connected.lock().unwrap() = true;
                    // After a reconnect, say we're idle again, and learn about servers and conversations joined meanwhile.
                    if *idle_flag.lock().unwrap() {
                        let _ = client.emit("presence.auto", json!({ "idle": true }));
                    }
                    Background::refresh_lists(http_c.clone(), origin_c.clone(), cookie_c.clone(), ctx_c.clone());
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(());
                    }
                })
                .on(Event::Close, move |_, _| {
                    *connected_on_close.lock().unwrap() = false;
                })
                .on("message.create", {
                    let (ctx, unread, emit, get_prefs) = (ctx.clone(), unread.clone(), emit.clone(), get_prefs.clone());
                    move |payload, _| {
                        let Payload::Text(values) = payload else { return };
                        let Some(m) = values.first() else { return };
                        let mut c = ctx.lock().unwrap();
                        c.prefs = get_prefs();
                        let Some(kind) = classify(m, &c) else { return };
                        let note = build_note(m, kind, &c);
                        drop(c);
                        let total = {
                            let mut u = unread.lock().unwrap();
                            u.add(&note.channel_id, &note.server_id);
                            u.total()
                        };
                        emit(BgEvent::Unread(total));
                        emit(BgEvent::Note(note, kind));
                    }
                })
                .on("dm.new", {
                    let ctx = ctx.clone();
                    move |payload, _| {
                        if let Payload::Text(v) = payload {
                            if let Some(id) = v.first().and_then(|d| d["id"].as_str()) {
                                ctx.lock().unwrap().dm_ids.insert(id.to_string());
                            }
                        }
                    }
                })
                .on("presence.self", {
                    let ctx = ctx.clone();
                    move |payload, _| {
                        if let Payload::Text(v) = payload {
                            ctx.lock().unwrap().presence = v.first().and_then(|p| p["presence"].as_str()).unwrap_or("online").to_string();
                        }
                    }
                })
                .connect()
        });
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(())) => {
                if let Ok(Ok(client)) = handle.await {
                    *socket_slot.lock().unwrap() = Some(client);
                }
                true
            }
            _ => {
                // Couldn't connect in time: let go of whatever was started.
                if let Ok(Ok(Ok(client))) = tokio::time::timeout(Duration::from_millis(500), handle).await {
                    let _ = client.disconnect();
                }
                false
            }
        }
    }

    /// The sign-in cookie this connection uses, so a reply can be sent while the page is unloaded.
    pub fn cookie(&self) -> String {
        self.cookie.clone()
    }
    pub fn mark_read(&self, channel_id: &str) {
        let total = {
            let mut u = self.unread.lock().unwrap();
            u.mark_read(channel_id);
            u.total()
        };
        (self.emit)(BgEvent::Unread(total));
    }
    pub fn next_unread_target(&self) -> Option<(String, String)> {
        self.unread.lock().unwrap().next_target()
    }
    pub fn stop(&self) {
        if let Some(s) = self.socket.lock().unwrap().take() {
            let _ = s.disconnect();
        }
        *self.connected.lock().unwrap() = false;
        self.unread.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_with(f: impl FnOnce(&mut Ctx)) -> Ctx {
        let mut c = Ctx { me_id: "me".into(), presence: "online".into(), ..Default::default() };
        c.dm_ids.insert("dm1".into());
        c.server_names.insert("s1".into(), "Game Night".into());
        f(&mut c);
        c
    }
    fn msg(extra: Value) -> Value {
        let mut m = json!({"authorId": "maya1", "authorName": "Maya", "serverId": "s1", "channelId": "c1", "content": "hi", "mentions": []});
        for (k, v) in extra.as_object().unwrap() { m[k] = v.clone(); }
        m
    }

    #[test]
    fn only_messages_meant_for_me_notify() {
        let c = ctx_with(|_| {});
        assert_eq!(classify(&msg(json!({})), &c), None);
        assert_eq!(classify(&msg(json!({"serverId": "dm1"})), &c), Some(Kind::Dm));
        assert_eq!(classify(&msg(json!({"mentions": ["me"]})), &c), Some(Kind::Mention));
        assert_eq!(classify(&msg(json!({"mentionsEveryone": true})), &c), Some(Kind::Everyone));
    }
    #[test]
    fn my_own_messages_do_not_disturb_and_switched_off_kinds_stay_quiet() {
        let c = ctx_with(|_| {});
        assert_eq!(classify(&msg(json!({"authorId": "me", "mentions": ["me"]})), &c), None);
        assert_eq!(classify(&msg(json!({"mentions": ["me"]})), &ctx_with(|c| c.presence = "dnd".into())), None);
        assert_eq!(classify(&msg(json!({"mentions": ["me"]})), &ctx_with(|c| c.prefs.mentions = false)), None);
        assert_eq!(classify(&msg(json!({"serverId": "dm1"})), &ctx_with(|c| c.prefs.enabled = false)), None);
        assert_eq!(classify(&json!("junk"), &c), None);
    }
    #[test]
    fn popup_text_matches_the_pages() {
        let c = ctx_with(|_| {});
        let n = build_note(&msg(json!({"content": "hello <:wave:123> ||secret||"})), Kind::Mention, &c);
        assert_eq!((n.title.as_str(), n.body.as_str()), ("Maya in Game Night", "hello :wave: [spoiler]"));
        assert_eq!((n.server_id.as_str(), n.channel_id.as_str(), n.tag.as_str()), ("s1", "c1", "c1"));
        assert_eq!(build_note(&msg(json!({"serverId": "dm1"})), Kind::Dm, &c).title, "Maya");
        assert_eq!(build_note(&msg(json!({"content": "secret"})), Kind::Mention, &ctx_with(|c| c.prefs.preview = false)).body, "Mentioned you");
        assert_eq!(build_note(&msg(json!({"content": "", "gif": "x"})), Kind::Mention, &c).body, "Sent a GIF");
        assert_eq!(build_note(&msg(json!({"content": "", "attachments": [1]})), Kind::Mention, &c).body, "Sent an attachment");
        assert_eq!(build_note(&msg(json!({"content": ""})), Kind::Mention, &c).body, "New message");
        assert_eq!(plain("  a \n b  "), "a b");
        assert_eq!(build_note(&msg(json!({"content": "x".repeat(300)})), Kind::Mention, &c).body.len(), 160);
    }
    #[test]
    fn unread_counts_and_the_oldest_target() {
        let mut u = Unread::default();
        assert_eq!(u.next_target(), None);
        u.add("c1", "s1");
        u.add("c2", "s2");
        u.add("c1", "s1");
        assert_eq!(u.total(), 3);
        assert_eq!(u.next_target(), Some(("s1".into(), "c1".into())));
        u.mark_read("c1");
        assert_eq!((u.total(), u.next_target()), (1, Some(("s2".into(), "c2".into()))));
        u.clear();
        assert_eq!(u.total(), 0);
    }
    #[test]
    fn prefs_fall_back_to_defaults() {
        assert_eq!(Prefs::from_json(&json!(null)), Prefs::default());
        let p = Prefs::from_json(&json!({"sound": false, "dms": "yes", "quiet": {"enabled": true}}));
        assert!(!p.sound && p.dms && p.quiet.enabled);
    }
}
