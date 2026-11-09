const test = require("node:test");
const assert = require("node:assert/strict");
const { downloadPageUrl } = require("../src/migrate");

test("the download page of the person's server is found", () => {
  assert.equal(downloadPageUrl("https://huddle.example.com"), "https://huddle.example.com/download");
  assert.equal(downloadPageUrl("huddle.example.com/invite/abc"), "https://huddle.example.com/download");
  assert.equal(downloadPageUrl("http://localhost:3000"), "http://localhost:3000/download");
});

test("no usable server address means no link", () => {
  for (const bad of [undefined, null, "", "huddle", "javascript:alert(1)", "http://example.com", 42]) assert.equal(downloadPageUrl(bad), null, String(bad));
});
