# Huddle desktop app (Rust)

The Huddle desktop app. It opens your Huddle server in its own window and adds the desktop extras (popups with a reply box,
unread badge, tray icon, staying open in the tray, global shortcuts, idle status, automatic updates, `huddle://` links, custom
themes). The website and the server need nothing special for it: the app gives the page a `window.huddleDesktop` object
(`ui/bridge.js`, which is how the website knows it is running in the app and not in a browser), and it reads the `latest.yml` update
feed (electron-builder's file format, which the server and download page already understand).

**There is no Electron here.** The app is a single small program built on `wry` + `tao` (the web-view and window libraries Tauri
uses, without Tauri itself, so it can check exactly which page sent each message). The page is drawn by the web view that already
comes with the operating system (WebView2 on Windows), so there is no bundled copy of Chromium and no Node. The old Electron app
was removed from this repository; its last version (2.x) only told people to install this one.

## Status: read this first

| | |
|---|---|
| Pure logic (addresses, links, shortcuts, idle, quiet hours, logging, update feed + download + checksum, notification rules) | **Done, 62 unit tests pass** |
| Running app on Linux (window, page bridge, popups, tray code, window buttons, shortcuts registering) | **Run for real** under a virtual display against a fake server |
| **Windows** (the only platform that is shipped) | **Never compiled or run.** It was written on Linux. The Windows-only branches are small (taskbar badge, `huddle://` registry entry, installer launch, screen work area, beep) but they are unverified. |
| Installer (`cargo-packager` / NSIS) and the GitHub workflow | **Never run.** |
| macOS | Compiles in principle; no logo menu or dock badge yet. Not a shipping target. |

Go through `WINDOWS-CHECKLIST.md` on a real Windows PC before each release.

## Run it

You need Rust 1.85 or newer (and, on Linux only, the GTK/WebKitGTK development packages).

```
cd desktop-rs
cargo run                                   # asks for your server's address the first time
HUDDLE_URL=http://localhost:3000 cargo run  # skip the question (plain http is only allowed for this computer)
cargo test
node --test test/*.test.js                  # the page bridge (ui/bridge.js), needs Node 22 or newer
```

To skip the question for everyone who installs your build, set `HUDDLE_DEFAULT_URL` when building (the workflow does this from the
`HUDDLE_URL` repository variable), or put `app.config.json` with `{ "defaultUrl": "https://..." }` next to the program.

## Build the installer and publish it

`.github/workflows/desktop-rs.yml` builds a Windows installer with `cargo-packager`, writes `latest.yml` (`scripts/make-latest-yml.js`)
and uploads both to the R2 `desktop/` folder, so `/download` and the in-app updater keep working. Run it from the repository's
**Actions** tab (**Desktop app (Rust)** → **Run workflow**), or push a tag such as `desktop-rs-v3.0.1`.

The version is `version` in `Cargo.toml`; **change `Cargo.lock` to match** (it has a `huddle-desktop` entry) or the `--locked` build fails.
It started at **3.0.0** so the last Electron apps (2.x) saw it as an update.

### Put it on your website's download page (a private repo is fine)

Huddle serves the installers itself at **`/download`**, so people never need access to the repository. The workflow uploads them to
the same Cloudflare R2 bucket your file storage already uses (under a `desktop/` folder, separate from message attachments); the
Huddle server reads them from there. One-time setup, in your repo's **Settings → Secrets and variables → Actions**:

| Where | Name | Value |
|---|---|---|
| Secrets | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the same four values the server uses for R2 (the key needs write access to the bucket) |
| Variables | `HUDDLE_URL` | your site, e.g. `https://huddle.onrender.com` (builds the address into the app so it connects without asking) |

After a run finishes (5–10 minutes) `https://your-site/download` lists the new version (the server checks for changes about once a
minute). Each run replaces the old installers. Anyone with the link can download, with or without an account. Downloads stream
through your server, so they count toward its bandwidth. Without R2 (local development), put the installer and a `latest.json`
(made by `node scripts/make-manifest.js <folder> > latest.json`) in a folder and set `DOWNLOADS_DIR` to it.

**The installer is unsigned.** Windows SmartScreen will say "unknown publisher" (More info → Run anyway). Removing that warning needs a
paid code-signing certificate.

## What changed for users

- **Custom themes** (Profile & appearance → Custom themes) work in the app and are stored in the web view's own storage, per computer and
  per server address. (Version 3.0.0 had a bug that made the website think it was in a browser, which hid this menu. Fixed in 3.0.1.)
- Settings (`%APPDATA%\Huddle\settings.json`) carry over from the Electron app: server address, tray and startup choices, shortcuts,
  notification choices, idle settings.
- **The sign-in and custom themes do not carry over.** Cookies and the themes (stored in the page's IndexedDB) live in the web
  view's own storage, which is a different folder from Electron's. People sign in again and re-import themes (export/import works).
- The window buttons are drawn by the app (Electron drew them with the system's title-bar overlay), so Windows 11 snap layouts
  on hover over the maximize button no longer appear. Drag, double-click to maximize, and Win+Arrow still work.
- The right-click menu is the web view's own (it has spelling suggestions and copy/save image, but no "Open link in browser").
- "Use less graphics memory" is gone (there is no equivalent switch in the web view); the "free memory when hidden in the tray"
  feature is kept.

## Known gaps (not ported yet)

- **Page crash recovery.** `crashguard.rs` is ported and tested, but the web view library does not tell the app when the page's
  process dies, so nothing calls it. A crashed page stays blank until reopened.
- **Lock screen / sleep triggers idle at once.** Idle status still works from keyboard and mouse inactivity, but a locked or
  sleeping computer only counts as idle after the chosen time rather than immediately, and waking doesn't trigger an update check.
- **Windows taskbar jump list** (Open / Check for updates / Quit when right-clicking the taskbar icon). The `--open`,
  `--check-updates` and `--quit` commands still work; only the menu that sends them is missing.
- **Crash dump files.** Electron's crash reporter saved dumps; Rust panics are written to the log instead, and "Copy debug info"
  reports 0 crash files.
- **"Reload" / load failures after start-up.** The server is checked before the page loads, and an unreachable server shows
  Huddle's "Can't reach Huddle" page, but if the connection drops while Huddle is open you see the web view's own error page.
- macOS/Linux: no automatic updates (never shipped), no dock badge, Linux has no taskbar badge.

## Layout

```
src/main.rs        start-up: one copy at a time, logging, runtime
src/app.rs         windows, tray, menus, popups, updates, message handling from pages
src/background.rs  the small connection that keeps popups working while the page is freed from memory
src/update.rs      update feed, download + checksum, schedule, "update ready" reminders
src/platform.rs    one-copy lock, start with computer, huddle:// registration, taskbar badge icons
src/ui.rs          the app's own pages, built into the program
ui/                splash, popups, setup page, and bridge.js (what the Huddle page sees as window.huddleDesktop)
test/              tests for bridge.js (node --test)
scripts/           latest.yml / download list / "should we release" helpers for CI
```
