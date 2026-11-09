#!/usr/bin/env node
/**
 * Writes latest.yml, the update feed installed apps read (the same file electron-builder used to write, so the Huddle server and
 * the R2 bucket need no changes). Usage: node scripts/make-latest-yml.js <folder with the installer>   (prints YAML to stdout)
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** The version in Cargo.toml's [package] section. */
function cargoVersion(text) {
  const pkg = /^\[package\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text);
  const v = pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg[1]);
  if (!v) throw new Error("No version in Cargo.toml");
  return v[1];
}

function build(dir, version, now = new Date()) {
  const exes = fs.readdirSync(dir).filter((n) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(n)).sort();
  if (!exes.length) throw new Error(`No installer (.exe) found in ${dir}`);
  const name = exes[0];
  const data = fs.readFileSync(path.join(dir, name));
  const sha512 = crypto.createHash("sha512").update(data).digest("base64");
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${data.length}`,
    `path: ${name}`,
    `sha512: ${sha512}`,
    `releaseDate: '${now.toISOString()}'`,
    "",
  ].join("\n");
}

module.exports = { cargoVersion, build };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: make-latest-yml.js <folder>");
    process.exit(2);
  }
  const version = cargoVersion(fs.readFileSync(path.join(__dirname, "..", "Cargo.toml"), "utf8"));
  process.stdout.write(build(dir, version));
}
