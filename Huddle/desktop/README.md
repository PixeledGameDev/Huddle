# Huddle desktop app

A small Electron app that opens your Huddle server in its own window and adds the desktop extras: system
notifications, an unread badge (taskbar / dock / tray), a tray icon, and staying open in the tray when you close the
window. It doesn't contain Huddle itself: it loads your server's web app, so it's always the same version as the server.

## Run it

```
cd desktop
npm install
npm start
```

The first time, it asks for your server's address (for example `https://huddle.example.com`) and checks that a Huddle
server is there. Change it later from **Huddle → Change server…** (or the tray menu). To skip the question for everyone
who installs your build, put the address in `app.config.json` (`"defaultUrl": "https://huddle.example.com"`) before
building. For development, `HUDDLE_URL=http://localhost:3000 npm start` works too (plain `http` is only allowed for
this computer).

## Put it on your website's download page (private repo is fine)

Huddle serves the installers itself at **`/download`**, so people never need access to the repository. The GitHub workflow
builds them and uploads them to the same Cloudflare R2 bucket your file storage already uses (under a `desktop/` folder,
separate from message attachments); the Huddle server reads them from there. One-time setup, in your repo's
**Settings → Secrets and variables → Actions**:

| Where | Name | Value |
|---|---|---|
| Secrets | `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the same four values the server uses for R2 (the key needs write access to the bucket) |
| Variables | `HUDDLE_URL` | your site, e.g. `https://huddle.onrender.com` (builds the address into the app so it connects without asking) |

Then run **Actions → Desktop app → Run workflow**. After 5–10 minutes the page `https://your-site/download` lists the
new version (the server checks for changes about once a minute). Each new run replaces the old installers. Anyone with
the link can download, with or without an account, and the page picks out the right build for their computer.
Downloads stream through your server, so they count toward its bandwidth.

Without R2 (local development), put the installers and a `latest.json` (made by
`node scripts/make-manifest.js <folder> > latest.json`) in a folder and set `DOWNLOADS_DIR` to it.

## Build installers

```
npm run dist        # builds for the system you're on, into desktop/dist
```

Only Windows is built: you get an installer (`.exe`). You can only build for
the system you're on, so the easiest way to get all three is the GitHub Actions workflow in
`.github/workflows/desktop.yml`: open the repo's **Actions** tab, pick **Desktop app**, **Run workflow**, and download
the files from the finished run (or push a tag such as `desktop-v1.0.0`).

**The installers are unsigned.** Windows SmartScreen will say "unknown publisher" (More info → Run anyway) and on
macOS you'll need to right-click the app → Open the first time. Removing those warnings needs paid code-signing
certificates (and, for macOS, an Apple Developer account); electron-builder supports both once you have them.

## Title bar and menu

Huddle draws its own title bar (version 1.2 and newer): there is no "File Edit View Window" bar. Click the **logo** at the top left
for the Huddle menu (change server, keep running in the tray, check for updates, zoom, reload, developer tools, quit). The
empty part of the bar drags the window, and the minimize/maximize/close buttons are the system's own, so Windows snap
layouts still work. The usual shortcuts work without a menu: Ctrl+R reload, Ctrl +/-/0 zoom, F11 full screen, F12 developer tools.
On macOS the normal menu bar at the top of the screen stays, as the system requires.

## Automatic updates and the splash screen

Installed copies update themselves. When you open the app it shows a splash screen ("Checking for updates…"), looks at
`<your server>/desktop-updates`, and if a newer version is there it downloads it (with a progress bar) and installs it
before Huddle opens. While the app is running it checks again every few hours; a finished download shows a *Restart now*
banner in Huddle plus a notification, and installs by itself the next time you quit. **Huddle → Check for updates…** (and
the tray menu) checks on demand. If your server can't be reached the app just opens as normal.

To ship an update: bump `version` in `package.json` (or push a tag such as `desktop-v1.2.0`, which the workflow uses as the
version) and run the **Desktop app** workflow. It publishes the installers *and* the update files (`latest*.yml`, `.zip`)
to the same R2 `desktop/` folder, and your server hands them to the apps. Notes:

- **Windows** (installer): updates work with unsigned builds.
- **Linux**: the **AppImage** updates itself; a `.deb` doesn't (install the newer `.deb` from `/download`).
- **macOS**: automatic updates only work once the app is **code-signed** (an Apple rule). Unsigned Macs keep working but
  need the new `.dmg` from `/download`.
- Apps older than 1.1 don't have the updater; they need one manual reinstall from `/download`, after which they update themselves.
- Set `HUDDLE_NO_AUTO_UPDATE=1` to turn automatic updates off. `npm start` never updates.

## Custom themes

Profile & appearance → **Custom themes** (desktop app only) opens a theme designer: every color of the interface,
background pictures for the whole window / chat area / sidebar, and export/import as a `.huddle-theme.json` file. Pictures
are chosen from the computer's files and stored in the app's own local storage (IndexedDB); they are not uploaded to
the server or to R2. Themes are per computer and per server address.

## What it does

- **Notifications** for direct messages, @mentions and @everyone, with a chime. They appear only when Huddle isn't the
  window you're looking at, and clicking one opens that conversation. Settings are in Huddle under *Profile &
  appearance → Notifications*.
- **Unread badge** on the taskbar icon (Windows), dock icon (macOS), launcher (Linux, where supported) and tray tooltip.
- **Tray icon**; closing the window keeps Huddle running so notifications keep arriving. Turn that off under
  Huddle → "Keep running in the tray when closed". Quit from the tray menu. (On Linux desktops without a tray, such as
  stock GNOME, turn this off, or reopen Huddle by launching it again.)
- Remembers window size and position, and only one copy runs at a time.

## Safety notes

The window only ever shows your Huddle server. Links to other sites open in your normal browser, and only `http(s)`
links are ever handed over. The page runs sandboxed with no Node access; it can talk to the app through three small
functions only (show a notification, set the badge, hear notification clicks), and the app ignores those from any page
that isn't your Huddle server. Browser permissions such as camera, microphone and location are refused.

## Tests

`npm test` checks the address handling and link-safety helpers. The rest (windows, tray, notifications) needs a real
desktop to try out.
