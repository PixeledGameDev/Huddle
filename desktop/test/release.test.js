const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");
const { decide, versionAt } = require("../scripts/should-release");

const push = { eventName: "push", ref: "refs/heads/main" };

test("a push that changes the version builds", () => {
  assert.deepStrictEqual(decide({ ...push, version: "1.9.4", previousVersion: "1.9.3" }).build, true);
});
test("a push that leaves the version alone does not", () => {
  const r = decide({ ...push, version: "1.9.3", previousVersion: "1.9.3" });
  assert.strictEqual(r.build, false);
  assert.match(r.reason, /still 1\.9\.3/);
});
test("running it by hand and pushing a release tag always build", () => {
  assert.strictEqual(decide({ eventName: "workflow_dispatch", ref: "refs/heads/main", version: "1.9.3", previousVersion: "1.9.3" }).build, true);
  assert.strictEqual(decide({ eventName: "push", ref: "refs/tags/desktop-v2.0.0", version: "1.9.3", previousVersion: "1.9.3" }).build, true);
});
test("when the earlier version can't be known it builds rather than miss a release", () => {
  assert.strictEqual(decide({ ...push, version: "1.0.0", previousVersion: null }).build, true);
});
test("the earlier version is read from the commit before the push", () => {
  const files = { "abc": '{"version":"1.2.3"}' };
  const git = (args) => { const m = /^([0-9a-f]{40}):/.exec(args[1]); if (!m || m[1] !== "a".repeat(40)) throw new Error("no such commit"); return files.abc; };
  assert.strictEqual(versionAt("a".repeat(40), git), "1.2.3");
  assert.strictEqual(versionAt("b".repeat(40), git), null); // a commit git doesn't have
  assert.strictEqual(versionAt("0".repeat(40), git), null); // a brand new branch
  assert.strictEqual(versionAt("", git), null);
  assert.strictEqual(versionAt("not-a-sha; rm -rf", git), null);
  assert.strictEqual(versionAt(undefined, git), null);
});

// The real script against a real (temporary) repository, the way GitHub runs it.
const gitOk = spawnSync("git", ["--version"]).status === 0;
test("end to end in a git repository: bumped version builds, unchanged version skips", { skip: !gitOk }, () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "huddle-release-"));
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  const write = (version) => {
    fs.mkdirSync(path.join(repo, "desktop", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "desktop", "package.json"), JSON.stringify({ version }));
    fs.copyFileSync(path.join(__dirname, "..", "scripts", "should-release.js"), path.join(repo, "desktop", "scripts", "should-release.js"));
  };
  const run = (before, eventName = "push", ref = "refs/heads/main") => {
    const out = path.join(repo, "out.txt");
    fs.rmSync(out, { force: true });
    const r = spawnSync("node", ["desktop/scripts/should-release.js"], { cwd: repo, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: eventName, GITHUB_REF: ref, BEFORE_SHA: before, GITHUB_OUTPUT: out } });
    assert.strictEqual(r.status, 0, r.stderr);
    return fs.readFileSync(out, "utf8").trim();
  };
  write("1.0.0"); git("add", "-A"); git("commit", "-qm", "one");
  const first = git("rev-parse", "HEAD");
  write("1.0.1"); git("add", "-A"); git("commit", "-qm", "bump");
  const second = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "desktop", "notes.txt"), "x"); git("add", "-A"); git("commit", "-qm", "unrelated");
  const third = git("rev-parse", "HEAD");
  assert.strictEqual(run(first), "build=true"); // 1.0.0 -> 1.0.1
  assert.strictEqual(run(second), "build=false"); // 1.0.1 -> 1.0.1
  assert.strictEqual(run(first, "push", "refs/tags/desktop-v1.0.1"), "build=true");
  assert.strictEqual(run("0".repeat(40)), "build=true"); // a new branch
  assert.strictEqual(run(third, "workflow_dispatch"), "build=true");
});
