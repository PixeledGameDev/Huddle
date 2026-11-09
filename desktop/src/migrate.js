// The last Electron version of Huddle only points people to the new app. The new app's installer is listed on the Huddle server's
// own download page, which always shows the current files, so this just needs that page's address.
const { normalizeServerUrl } = require("./url");

/** The server's download page for the address someone had set up, or null if there isn't a usable one. */
function downloadPageUrl(serverUrl) {
  const origin = normalizeServerUrl(typeof serverUrl === "string" ? serverUrl : "");
  return origin ? new URL("/download", origin).toString() : null;
}

module.exports = { downloadPageUrl };
