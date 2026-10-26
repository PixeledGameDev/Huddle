const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { classify, build } = require("../scripts/make-manifest");

test("installers are recognised by name", () => {
  assert.deepStrictEqual(classify("Huddle-1.0.0-win-x64.exe"), { platform: "windows", arch: "x64", kind: "exe" });
  assert.deepStrictEqual(classify("Huddle-1.0.0-mac-arm64.dmg"), { platform: "mac", arch: "arm64", kind: "dmg" });
  assert.deepStrictEqual(classify("Huddle-1.0.0-mac-x64.dmg"), { platform: "mac", arch: "x64", kind: "dmg" });
  assert.deepStrictEqual(classify("Huddle-1.0.0-linux-x86_64.AppImage"), { platform: "linux", arch: "x64", kind: "AppImage" });
  assert.deepStrictEqual(classify("Huddle-1.0.0-linux-amd64.deb"), { platform: "linux", arch: "x64", kind: "deb" });
  assert.strictEqual(classify("latest.yml"), null);
  assert.strictEqual(classify("Huddle-1.0.0-mac-arm64.zip"), null);
  assert.strictEqual(classify("Huddle.exe.blockmap"), null);
});

test("the manifest lists size and checksum of each installer and skips everything else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huddle-"));
  fs.writeFileSync(path.join(dir, "Huddle-1.0.0-win-x64.exe"), "abc");
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
  const m = build(dir);
  assert.strictEqual(m.files.length, 1);
  assert.strictEqual(m.files[0].size, 3);
  assert.strictEqual(m.files[0].sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // sha256("abc")
});
