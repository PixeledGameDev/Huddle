//! Automatic updates (port of desktop/src/update.js and updatecheck.js).
//!
//! The app checks the Huddle server it is connected to (its /desktop-updates folder, which serves the files the "Desktop app"
//! workflow publishes) and installs newer versions by itself. The feed is the same `latest.yml` electron-builder wrote, so the
//! server, the R2 bucket and the download page need no changes: this reads `version`, the installer's file name and its
//! sha512, downloads the installer, checks the checksum, and runs it silently.
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha512};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where this server keeps the update files.
pub fn update_feed_url(origin: Option<&str>) -> Option<String> {
    origin.map(|o| format!("{}/desktop-updates", o.trim_end_matches('/')))
}

/// Which builds can update themselves: only installed (release) builds, never a build run from source, and only on Windows,
/// the one platform the installer is built for. Set HUDDLE_NO_AUTO_UPDATE=1 to turn it off.
pub fn can_auto_update(is_packaged: bool, platform: &str, no_auto_update: bool) -> bool {
    is_packaged && !no_auto_update && platform == "windows"
}

/// "1.2.0" is newer than "1.1.9"; anything that isn't a plain version compares as not newer.
pub fn is_newer_version(candidate: &str, current: &str) -> bool {
    fn parse(v: &str) -> Option<[u64; 3]> {
        let mut it = v.split(|c| c == '.' || c == '+' || c == '-');
        let mut out = [0u64; 3];
        for slot in out.iter_mut() {
            *slot = it.next()?.parse().ok()?;
        }
        Some(out)
    }
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_to_date: Option<bool>,
}

impl UpdateState {
    pub fn idle() -> Self { UpdateState { status: "idle".into(), ..Default::default() } }
    #[allow(dead_code)]
    pub fn unsupported() -> Self { UpdateState { status: "unsupported".into(), ..Default::default() } }
    fn up_to_date() -> Self { UpdateState { status: "idle".into(), up_to_date: Some(true), ..Default::default() } }
    fn checking() -> Self { UpdateState { status: "checking".into(), ..Default::default() } }
    fn downloading(version: &str, percent: u8) -> Self { UpdateState { status: "downloading".into(), version: Some(version.into()), percent: Some(percent), ..Default::default() } }
    fn ready(version: &str) -> Self { UpdateState { status: "ready".into(), version: Some(version.into()), ..Default::default() } }
    fn error(message: impl AsRef<str>) -> Self { UpdateState { status: "error".into(), message: Some(message.as_ref().chars().take(200).collect()), ..Default::default() } }
    pub fn is_ready(&self) -> bool { self.status == "ready" }
}

// ---------- the feed (electron-builder's latest.yml) ----------

#[derive(Debug, Deserialize)]
struct Feed {
    version: String,
    #[serde(default)]
    files: Vec<FeedFile>,
    path: Option<String>,
    sha512: Option<String>,
}
#[derive(Debug, Deserialize)]
struct FeedFile {
    url: String,
    sha512: String,
}

#[derive(Debug, PartialEq)]
pub struct Release {
    pub version: String,
    pub file_name: String,
    /// base64 of the SHA-512 digest, as electron-builder writes it.
    pub sha512: String,
}

/// The same shape the server allows: a plain name, nothing that could point outside the update folder.
fn safe_file_name(name: &str) -> bool {
    let ok_chars = name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    ok_chars && !name.is_empty() && name.len() <= 125 && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && !name.contains("..") && name.ends_with(".exe")
}

pub fn parse_feed(yaml: &str) -> Result<Release, String> {
    let feed: Feed = serde_yaml_ng::from_str(yaml).map_err(|e| format!("The update list couldn't be read ({e})."))?;
    let from_files = feed.files.iter().find(|f| f.url.ends_with(".exe")).map(|f| (f.url.clone(), f.sha512.clone()));
    let (name, sha) = from_files
        .or_else(|| feed.path.clone().zip(feed.sha512.clone()))
        .ok_or_else(|| "The update list has no Windows installer.".to_string())?;
    if !safe_file_name(&name) {
        return Err("The update list names a file that isn't allowed.".into());
    }
    Ok(Release { version: feed.version, file_name: name, sha512: sha })
}

fn sha512_base64_of_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        hasher.update(&buf[..n]);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(hasher.finalize()))
}

// ---------- the updater ----------

type StateCallback = Arc<dyn Fn(UpdateState) + Send + Sync>;

pub struct Updater {
    client: reqwest::Client,
    dir: PathBuf,
    current: String,
    state: Mutex<UpdateState>,
    installer: Mutex<Option<PathBuf>>,
    checking: Mutex<bool>,
    on_state: StateCallback,
}

impl Updater {
    pub fn new(dir: PathBuf, current: &str, on_state: StateCallback) -> Arc<Self> {
        let client = reqwest::Client::builder().user_agent(format!("HuddleDesktop/{current}")).connect_timeout(Duration::from_secs(15)).build().unwrap_or_default();
        Arc::new(Updater { client, dir, current: current.into(), state: Mutex::new(UpdateState::idle()), installer: Mutex::new(None), checking: Mutex::new(false), on_state })
    }
    pub fn state(&self) -> UpdateState { self.state.lock().unwrap().clone() }
    /// The downloaded installer, when an update is ready to install.
    pub fn ready_installer(&self) -> Option<PathBuf> {
        if self.state().is_ready() { self.installer.lock().unwrap().clone() } else { None }
    }
    fn set(&self, next: UpdateState) {
        *self.state.lock().unwrap() = next.clone();
        (self.on_state)(next);
    }

    /// Looks for an update and downloads it. Does nothing while one is downloading or waiting to be installed.
    pub async fn check(&self, feed_url: &str) -> UpdateState {
        {
            let mut checking = self.checking.lock().unwrap();
            let status = self.state().status;
            if *checking || status == "downloading" || status == "ready" {
                return self.state();
            }
            *checking = true;
        }
        self.set(UpdateState::checking());
        let result = self.check_inner(feed_url).await;
        *self.checking.lock().unwrap() = false;
        if let Err(message) = result {
            self.set(UpdateState::error(message));
        }
        self.state()
    }

    async fn check_inner(&self, feed_url: &str) -> Result<(), String> {
        let yaml = self.client.get(format!("{feed_url}/latest.yml")).timeout(Duration::from_secs(15)).send().await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Couldn't reach the update server ({})", e.without_url()))?
            .text().await.map_err(|e| format!("Couldn't read the update list ({})", e.without_url()))?;
        let release = parse_feed(&yaml)?;
        if !is_newer_version(&release.version, &self.current) {
            self.set(UpdateState::up_to_date());
            return Ok(());
        }
        let target = self.dir.join(&release.file_name);
        // Already downloaded earlier (and still intact)? Then there is nothing to fetch.
        if sha512_base64_of_file(&target).map(|h| h == release.sha512).unwrap_or(false) {
            *self.installer.lock().unwrap() = Some(target);
            self.set(UpdateState::ready(&release.version));
            return Ok(());
        }
        self.set(UpdateState::downloading(&release.version, 0));
        self.download(feed_url, &release, &target).await
    }

    async fn download(&self, feed_url: &str, release: &Release, target: &Path) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("Couldn't prepare the update folder ({e})"))?;
        let part = target.with_extension("exe.part");
        let resp = self.client.get(format!("{feed_url}/{}", release.file_name)).send().await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("The update couldn't be downloaded ({})", e.without_url()))?;
        let total = resp.content_length().unwrap_or(0);
        let mut file = tokio::fs::File::create(&part).await.map_err(|e| format!("Couldn't save the update ({e})"))?;
        let mut stream = resp.bytes_stream();
        let (mut got, mut last_percent) = (0u64, 0u8);
        use tokio::io::AsyncWriteExt;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("The download was interrupted ({})", e.without_url()))?;
            file.write_all(&chunk).await.map_err(|e| format!("Couldn't save the update ({e})"))?;
            got += chunk.len() as u64;
            if total > 0 {
                let percent = ((got * 100) / total).min(100) as u8;
                if percent != last_percent {
                    last_percent = percent;
                    self.set(UpdateState::downloading(&release.version, percent));
                }
            }
        }
        file.flush().await.map_err(|e| format!("Couldn't save the update ({e})"))?;
        drop(file);
        let actual = sha512_base64_of_file(&part).map_err(|e| format!("Couldn't check the update ({e})"))?;
        if actual != release.sha512 {
            let _ = std::fs::remove_file(&part);
            return Err("The downloaded update didn't match its checksum, so it was thrown away.".into());
        }
        std::fs::rename(&part, target).map_err(|e| format!("Couldn't finish saving the update ({e})"))?;
        *self.installer.lock().unwrap() = Some(target.to_path_buf());
        self.set(UpdateState::ready(&release.version));
        Ok(())
    }

    /// For the splash screen: checks, and if an update is found waits for it to download (progress goes through the state
    /// callback). Returns true when there is an update to install now; false for no update, an error, or too slow.
    pub async fn startup_check(&self, feed_url: &str) -> bool {
        if self.state().is_ready() {
            return true;
        }
        let _ = tokio::time::timeout(Duration::from_secs(15 + 180), self.check(feed_url)).await;
        self.state().is_ready()
    }
}

/// Starts the downloaded installer silently and lets it reopen Huddle afterwards. Windows only; the caller quits right after.
pub fn launch_installer(installer: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let exe = std::env::current_exe()?;
        let quote = |p: &Path| p.to_string_lossy().replace('\'', "''");
        // Wait a moment for this app to close, run the installer silently, then open the new version.
        let script = format!(
            "Start-Sleep -Seconds 2; Start-Process -FilePath '{}' -ArgumentList '/S' -Wait; Start-Process -FilePath '{}'",
            quote(installer), quote(&exe)
        );
        std::process::Command::new("powershell").args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]).creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW).spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = installer;
        Err(std::io::Error::other("Automatic installation is only available on Windows."))
    }
}

// ---------- when to look, and when to tell the person ----------

/// Looks for updates every 45 minutes, soon after something that suggests the computer was away (waking, unlocking, opening
/// the window), and again sooner after a failure, which is common when a free server is still waking up.
#[derive(Debug, Clone, Copy)]
pub struct Schedule {
    pub interval: Duration,
    pub first_check: Duration,
    pub retry: Duration,
    pub retry_max: Duration,
    pub min_gap: Duration,
}

impl Default for Schedule {
    fn default() -> Self {
        Schedule { interval: Duration::from_secs(45 * 60), first_check: Duration::from_secs(2 * 60), retry: Duration::from_secs(5 * 60), retry_max: Duration::from_secs(60 * 60), min_gap: Duration::from_secs(10 * 60) }
    }
}

impl Schedule {
    /// How long to wait before the next check, given how many checks in a row have failed.
    pub fn next_delay(&self, failures: u32) -> Duration {
        if failures == 0 {
            return self.interval;
        }
        self.retry.saturating_mul(2u32.saturating_pow(failures - 1)).min(self.retry_max)
    }
    /// An event ("poke") never causes a check sooner than `min_gap` after the last one.
    pub fn poke_allowed(&self, since_last_check: Option<Duration>) -> bool {
        since_last_check.map_or(true, |d| d >= self.min_gap)
    }
}

/// Shows "update ready" once per version, reminds again after a day if it's ignored, and waits out quiet hours.
pub struct UpdateNotifier {
    shown_version: Option<String>,
    shown_at: Option<Instant>,
    remind_every: Duration,
}

impl UpdateNotifier {
    pub fn new() -> Self {
        UpdateNotifier { shown_version: None, shown_at: None, remind_every: Duration::from_secs(24 * 60 * 60) }
    }
    /// Called whenever the update state changes or an hour passes. Returns Some(is_reminder) when the popup is due.
    pub fn consider(&mut self, state: &UpdateState, quiet: bool, now: Instant) -> Option<bool> {
        let version = state.version.as_ref().filter(|_| state.is_ready())?;
        if quiet {
            return None; // held back, and shown at the next look after quiet hours end
        }
        let first = self.shown_version.as_ref() != Some(version);
        if !first && self.shown_at.is_some_and(|t| now.duration_since(t) < self.remind_every) {
            return None;
        }
        self.shown_version = Some(version.clone());
        self.shown_at = Some(now);
        Some(!first)
    }
    /// "Later" or dismissed: the next reminder is a full interval from now.
    pub fn snooze(&mut self, now: Instant) {
        self.shown_at = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feed_url_and_platform_rules() {
        assert_eq!(update_feed_url(Some("https://h.example.com/")).as_deref(), Some("https://h.example.com/desktop-updates"));
        assert_eq!(update_feed_url(None), None);
        assert!(can_auto_update(true, "windows", false));
        assert!(!can_auto_update(false, "windows", false));
        assert!(!can_auto_update(true, "windows", true));
        assert!(!can_auto_update(true, "linux", false) && !can_auto_update(true, "macos", false));
    }
    #[test]
    fn versions_compare_numerically() {
        assert!(is_newer_version("1.2.0", "1.1.9"));
        assert!(is_newer_version("2.0.0", "1.99.99"));
        assert!(is_newer_version("1.10.0", "1.9.0"));
        assert!(!is_newer_version("1.2.0", "1.2.0"));
        assert!(!is_newer_version("1.1.9", "1.2.0"));
        assert!(!is_newer_version("latest", "1.0.0") && !is_newer_version("1.0.0", "x"));
        assert!(is_newer_version("2.0.1-beta.1", "2.0.0"));
    }
    const FEED: &str = "version: 2.1.0\nfiles:\n  - url: Huddle-2.1.0-win-x64.exe\n    sha512: abc123==\n    size: 1000\npath: Huddle-2.1.0-win-x64.exe\nsha512: abc123==\nreleaseDate: '2026-11-01T00:00:00.000Z'\n";
    #[test]
    fn the_electron_builder_feed_is_understood() {
        assert_eq!(parse_feed(FEED).unwrap(), Release { version: "2.1.0".into(), file_name: "Huddle-2.1.0-win-x64.exe".into(), sha512: "abc123==".into() });
        let path_only = "version: 2.1.0\npath: Huddle-2.1.0.exe\nsha512: zzz==\n";
        assert_eq!(parse_feed(path_only).unwrap().file_name, "Huddle-2.1.0.exe");
    }
    #[test]
    fn a_bad_feed_is_refused() {
        assert!(parse_feed("not: [valid").is_err());
        assert!(parse_feed("version: 2.1.0\n").is_err());
        for evil in ["../evil.exe", "dir/evil.exe", "..\\evil.exe", "evil.exe.bat", ".hidden.exe", "a..b.exe", "http://x/evil.exe", "spaced name.exe"] {
            let feed = format!("version: 9.0.0\npath: \"{evil}\"\nsha512: x\n");
            assert!(parse_feed(&feed).is_err(), "{evil}");
        }
    }
    #[test]
    fn checksums_are_electron_builders_base64_sha512() {
        let p = std::env::temp_dir().join(format!("huddle-sha-test-{}", std::process::id()));
        std::fs::write(&p, "abc").unwrap();
        // SHA-512("abc") in base64
        assert_eq!(sha512_base64_of_file(&p).unwrap(), "3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==");
        let _ = std::fs::remove_file(p);
    }
    #[test]
    fn retries_back_off_and_a_poke_waits_its_turn() {
        let s = Schedule::default();
        let mins = |n: u64| Duration::from_secs(n * 60);
        assert_eq!(s.next_delay(0), mins(45));
        assert_eq!([1, 2, 3, 4, 5, 9].map(|f| s.next_delay(f)), [mins(5), mins(10), mins(20), mins(40), mins(60), mins(60)]);
        assert!(s.poke_allowed(None) && s.poke_allowed(Some(mins(10))));
        assert!(!s.poke_allowed(Some(mins(9))));
    }
    #[test]
    fn the_ready_popup_is_shown_once_then_as_a_daily_reminder() {
        let mut n = UpdateNotifier::new();
        let t0 = Instant::now();
        let ready = UpdateState::ready("2.1.0");
        assert_eq!(n.consider(&UpdateState::idle(), false, t0), None);
        assert_eq!(n.consider(&UpdateState::downloading("2.1.0", 50), false, t0), None);
        assert_eq!(n.consider(&ready, true, t0), None); // quiet hours hold it back
        assert_eq!(n.consider(&ready, false, t0), Some(false));
        assert_eq!(n.consider(&ready, false, t0 + Duration::from_secs(3600)), None);
        assert_eq!(n.consider(&ready, false, t0 + Duration::from_secs(24 * 3600)), Some(true));
        n.snooze(t0 + Duration::from_secs(25 * 3600));
        assert_eq!(n.consider(&ready, false, t0 + Duration::from_secs(26 * 3600)), None);
        assert_eq!(n.consider(&UpdateState::ready("2.2.0"), false, t0 + Duration::from_secs(26 * 3600)), Some(false)); // a newer version is announced at once
    }
    /// A tiny web server standing in for the Huddle server's /desktop-updates folder.
    fn serve(files: Vec<(&'static str, Vec<u8>)>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let name = path.rsplit('/').next().unwrap_or("");
                match files.iter().find(|(n, _)| *n == name) {
                    Some((_, body)) => {
                        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes());
                        let _ = stream.write_all(body);
                    }
                    None => { let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); }
                }
            }
        });
        format!("http://{addr}/desktop-updates")
    }
    fn updater_in(name: &str, current: &str) -> (Arc<Updater>, PathBuf, Arc<Mutex<Vec<String>>>) {
        let dir = std::env::temp_dir().join(format!("huddle-upd-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let s2 = seen.clone();
        let u = Updater::new(dir.clone(), current, Arc::new(move |st| s2.lock().unwrap().push(st.status)));
        (u, dir, seen)
    }
    fn feed_for(version: &str, exe: &str, body: &[u8], sha_of: &[u8]) -> String {
        use base64::Engine;
        let sha = base64::engine::general_purpose::STANDARD.encode(Sha512::digest(sha_of));
        let _ = body;
        format!("version: {version}\nfiles:\n  - url: {exe}\n    sha512: {sha}\n    size: {}\npath: {exe}\nsha512: {sha}\n", body.len())
    }

    #[tokio::test]
    async fn a_newer_version_is_downloaded_checked_and_made_ready() {
        let installer = vec![7u8; 300_000];
        let url = serve(vec![("latest.yml", feed_for("9.0.0", "Huddle_9.0.0_x64-setup.exe", &installer, &installer).into_bytes()), ("Huddle_9.0.0_x64-setup.exe", installer.clone())]);
        let (u, dir, seen) = updater_in("good", "3.0.0");
        let state = u.check(&url).await;
        assert_eq!((state.status.as_str(), state.version.as_deref()), ("ready", Some("9.0.0")));
        let path = u.ready_installer().expect("installer path");
        assert_eq!(std::fs::read(&path).unwrap(), installer);
        assert!(!dir.join("Huddle_9.0.0_x64-setup.exe.part").exists());
        let seen = seen.lock().unwrap().clone();
        assert!(seen.first().map(String::as_str) == Some("checking") && seen.contains(&"downloading".to_string()) && seen.last().map(String::as_str) == Some("ready"), "{seen:?}");
        // Asking again while an update waits to be installed does nothing.
        assert_eq!(u.check(&url).await.status, "ready");
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn a_download_that_does_not_match_its_checksum_is_thrown_away() {
        let real = vec![1u8; 5000];
        let tampered = vec![2u8; 5000];
        let url = serve(vec![("latest.yml", feed_for("9.0.0", "Huddle_9.0.0_x64-setup.exe", &real, &real).into_bytes()), ("Huddle_9.0.0_x64-setup.exe", tampered)]);
        let (u, dir, _) = updater_in("bad", "3.0.0");
        let state = u.check(&url).await;
        assert_eq!(state.status, "error");
        assert!(state.message.unwrap().contains("checksum"));
        assert!(u.ready_installer().is_none());
        assert!(!dir.join("Huddle_9.0.0_x64-setup.exe").exists() && !dir.join("Huddle_9.0.0_x64-setup.exe.part").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn no_newer_version_means_up_to_date_and_an_unreachable_server_is_an_error() {
        let url = serve(vec![("latest.yml", feed_for("3.0.0", "Huddle_3.0.0_x64-setup.exe", b"x", b"x").into_bytes())]);
        let (u, dir, _) = updater_in("same", "3.0.0");
        let state = u.check(&url).await;
        assert_eq!((state.status.as_str(), state.up_to_date), ("idle", Some(true)));
        let (u2, dir2, _) = updater_in("down", "3.0.0");
        assert_eq!(u2.check("http://127.0.0.1:1/desktop-updates").await.status, "error");
        let _ = (std::fs::remove_dir_all(dir), std::fs::remove_dir_all(dir2));
    }
    #[tokio::test]
    async fn an_installer_downloaded_earlier_is_reused_without_downloading_again() {
        let installer = vec![9u8; 2000];
        let yml = feed_for("9.0.0", "Huddle_9.0.0_x64-setup.exe", &installer, &installer).into_bytes();
        let (u, dir, seen) = updater_in("reuse", "3.0.0");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Huddle_9.0.0_x64-setup.exe"), &installer).unwrap();
        let url = serve(vec![("latest.yml", yml)]); // the installer itself is deliberately not offered
        assert_eq!(u.check(&url).await.status, "ready");
        assert!(!seen.lock().unwrap().contains(&"downloading".to_string()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn state_serializes_the_way_the_page_expects() {
        assert_eq!(serde_json::to_value(UpdateState::downloading("2.1.0", 40)).unwrap(), serde_json::json!({"status": "downloading", "version": "2.1.0", "percent": 40}));
        assert_eq!(serde_json::to_value(UpdateState::up_to_date()).unwrap(), serde_json::json!({"status": "idle", "upToDate": true}));
        assert_eq!(serde_json::to_value(UpdateState::error("x".repeat(500))).unwrap()["message"].as_str().unwrap().len(), 200);
    }
}
