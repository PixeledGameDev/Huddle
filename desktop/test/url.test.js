const test = require("node:test");
const assert = require("node:assert");
const { normalizeServerUrl, sameOrigin, isSafeExternal } = require("../src/url");

test("server addresses are cleaned up", () => {
  assert.strictEqual(normalizeServerUrl("huddle.example.com"), "https://huddle.example.com");
  assert.strictEqual(normalizeServerUrl("  https://huddle.example.com/invite/abc?x=1  "), "https://huddle.example.com");
  assert.strictEqual(normalizeServerUrl("https://huddle.onrender.com:8443/"), "https://huddle.onrender.com:8443");
});
test("plain http is only for this computer", () => {
  assert.strictEqual(normalizeServerUrl("http://localhost:3000"), "http://localhost:3000");
  assert.strictEqual(normalizeServerUrl("http://127.0.0.1:3000/x"), "http://127.0.0.1:3000");
  assert.strictEqual(normalizeServerUrl("http://huddle.example.com"), null);
});
test("junk and risky addresses are refused", () => {
  for (const bad of ["", "   ", null, undefined, "huddle", "javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "https://user:pw@example.com", "https://" + "a".repeat(400) + ".com"])
    assert.strictEqual(normalizeServerUrl(bad), null, String(bad));
});
test("same-origin check", () => {
  assert.ok(sameOrigin("https://huddle.example.com/invite/x", "https://huddle.example.com"));
  assert.ok(!sameOrigin("https://huddle.example.com.evil.com/", "https://huddle.example.com"));
  assert.ok(!sameOrigin("http://huddle.example.com/", "https://huddle.example.com"));
  assert.ok(!sameOrigin("https://huddle.example.com/", null));
  assert.ok(!sameOrigin("not a url", "https://huddle.example.com"));
});
test("only web links go to the system browser", () => {
  assert.ok(isSafeExternal("https://example.com/a"));
  assert.ok(isSafeExternal("http://example.com"));
  for (const bad of ["file:///C:/Windows/System32/calc.exe", "javascript:alert(1)", "smb://host/share", "ms-msdt:/id", "nonsense"]) assert.ok(!isSafeExternal(bad), bad);
});
