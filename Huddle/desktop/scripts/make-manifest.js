#!/usr/bin/env node
/**
 * Writes latest.json, the list of installers the website offers for download.
 * Usage: node scripts/make-manifest.js <folder with the installers>   (prints JSON to stdout)
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const version = require("../package.json").version;

/** Works out what an installer is for from its file name, or null if it isn't one we offer. */
function classify(name) {
  const kind = name.endsWith(".exe") ? "exe" : name.endsWith(".dmg") ? "dmg" : name.endsWith(".AppImage") ? "AppImage" : name.endsWith(".deb") ? "deb" : null;
  if (!kind) return null;
  const platform = kind === "exe" ? "windows" : kind === "dmg" ? "mac" : "linux";
  const arch = /arm64|aarch64/i.test(name) ? "arm64" : "x64";
  return { platform, arch, kind };
}

function build(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const info = classify(name);
    const full = path.join(dir, name);
    if (!info || !fs.statSync(full).isFile()) continue;
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(full));
    files.push({ ...info, name, size: fs.statSync(full).size, sha256: hash.digest("hex") });
  }
  return { version, builtAt: new Date().toISOString(), files };
}

module.exports = { classify, build };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: make-manifest.js <folder>");
    process.exit(2);
  }
  const manifest = build(dir);
  if (!manifest.files.length) {
    console.error(`No installers found in ${dir}`);
    process.exit(1);
  }
  console.log(JSON.stringify(manifest, null, 2));
}
