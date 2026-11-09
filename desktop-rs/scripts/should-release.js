#!/usr/bin/env node
/**
 * Decides whether a push should build and publish the desktop app: only when the version in desktop-rs/Cargo.toml changed.
 * (Running the workflow by hand, or pushing a desktop-v… tag, always builds.)
 * Used by .github/workflows/desktop.yml; run from the repository root. Prints the reason and sets the `build` output.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { cargoVersion } = require("./make-latest-yml");

const ZEROS = /^0+$/;

/** `previousVersion` is the version before this push, or null when it can't be known (a new branch, no earlier file). */
function decide({ eventName, ref, version, previousVersion }) {
  if (eventName !== "push") return { build: true, reason: "started by hand" };
  if (String(ref).startsWith("refs/tags/")) return { build: true, reason: "a release tag was pushed" };
  if (!previousVersion) return { build: true, reason: `no earlier version to compare with, so building ${version}` };
  if (version !== previousVersion) return { build: true, reason: `the version changed from ${previousVersion} to ${version}` };
  return { build: false, reason: `the version is still ${version}, so there is nothing new to release (bump the version in desktop-rs/Cargo.toml, or run the workflow by hand)` };
}

/** The version in desktop-rs/Cargo.toml as it was at commit `sha`, or null. */
function versionAt(sha, git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? "") || ZEROS.test(sha)) return null;
  try {
    return cargoVersion(git(["show", `${sha}:desktop-rs/Cargo.toml`]));
  } catch {
    return null;
  }
}

module.exports = { decide, versionAt };

if (require.main === module) {
  const version = cargoVersion(fs.readFileSync(path.join(__dirname, "..", "Cargo.toml"), "utf8"));
  const result = decide({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    version,
    previousVersion: versionAt(process.env.BEFORE_SHA),
  });
  console.log(`Desktop ${version}: ${result.build ? "building" : "skipping"}, ${result.reason}.`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `build=${result.build}\n`);
}
