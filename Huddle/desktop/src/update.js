/**
 * Automatic updates. The app checks the Huddle server it is connected to (its /desktop-updates folder, which serves the
 * files the "Desktop app" workflow publishes) and installs newer versions by itself.
 *
 * Everything here takes the updater as a parameter so it can be tested without Electron.
 */

/** Where this server keeps the update files. */
function updateFeedUrl(origin) {
  return origin ? `${origin.replace(/\/+$/, "")}/desktop-updates` : null;
}

/**
 * Which builds can update themselves: only installed (packaged) apps, never `npm start`, and on Linux only the AppImage
 * (a .deb is updated by installing the new .deb). Set HUDDLE_NO_AUTO_UPDATE=1 to turn it off.
 */
function canAutoUpdate({ isPackaged, platform, env }) {
  if (!isPackaged || env.HUDDLE_NO_AUTO_UPDATE) return false;
  if (platform === "linux") return !!env.APPIMAGE;
  return platform === "win32" || platform === "darwin";
}

/** "1.2.0" is newer than "1.1.9"; anything that isn't a plain version compares as not newer. */
function isNewerVersion(candidate, current) {
  const parse = (v) => (/^\d+\.\d+\.\d+/.test(String(v)) ? String(v).split(/[.+-]/).slice(0, 3).map(Number) : null);
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function createUpdater({ autoUpdater, onState = () => {}, log = () => {} }) {
  let state = { status: "idle" };
  let checking = false;
  const set = (next) => {
    state = next;
    onState(state);
  };

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableDifferentialDownload = true; // the server hands out whole files, not byte ranges

  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-available", (info) => set({ status: "downloading", version: info?.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => set({ status: "idle", upToDate: true }));
  autoUpdater.on("download-progress", (p) => set({ status: "downloading", version: state.version, percent: Math.max(0, Math.min(100, Math.round(p?.percent ?? 0))) }));
  autoUpdater.on("update-downloaded", (info) => set({ status: "ready", version: info?.version ?? state.version }));
  autoUpdater.on("error", (err) => {
    log("update error", err);
    set({ status: "error", message: String(err?.message ?? err).slice(0, 200) });
  });

  /** Looks for an update. Does nothing while one is downloading or waiting to be installed. */
  async function check(feedUrl) {
    if (!feedUrl || checking || state.status === "downloading" || state.status === "ready") return state;
    checking = true;
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
      await autoUpdater.checkForUpdates();
    } catch (e) {
      log("update check failed", e);
      if (state.status !== "error") set({ status: "error", message: String(e?.message ?? e).slice(0, 200) });
    } finally {
      checking = false;
    }
    return state;
  }

  /**
   * For the splash screen: checks, and if an update is found waits for it to download (reporting progress).
   * Resolves "ready" when there is an update to install now, "none" otherwise (no update, an error, or too slow).
   */
  function startupCheck(feedUrl, { onProgress = () => {}, findTimeoutMs = 15000, downloadTimeoutMs = 180000 } = {}) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        listeners.forEach(([ev, fn]) => autoUpdater.removeListener(ev, fn));
        resolve(result);
      };
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => finish("none"), ms);
      };
      const onAny = () => {
        if (state.status === "downloading") {
          arm(downloadTimeoutMs);
          onProgress(state);
        } else if (state.status === "ready") finish("ready");
        else if (state.status === "idle" || state.status === "error") finish("none");
      };
      const listeners = ["checking-for-update", "update-available", "update-not-available", "download-progress", "update-downloaded", "error"].map((ev) => [ev, onAny]);
      listeners.forEach(([ev, fn]) => autoUpdater.on(ev, fn));
      arm(findTimeoutMs);
      if (state.status === "ready") return finish("ready");
      void check(feedUrl).then(() => onAny());
    });
  }

  return {
    check,
    startupCheck,
    getState: () => state,
    // Silent, then reopen: the person only sees the splash screen, not an installer window.
    installNow: () => autoUpdater.quitAndInstall(true, true),
  };
}

module.exports = { updateFeedUrl, canAutoUpdate, isNewerVersion, createUpdater };
