const test = require("node:test");
const assert = require("node:assert");
const { classify, buildNote, plain } = require("../src/background");

const prefs = { enabled: true, sound: true, preview: true, dms: true, mentions: true, everyone: true };
const ctx = (over = {}) => ({ meId: "me", presence: "online", dmIds: new Set(["dm1"]), serverNames: new Map([["s1", "Game Night"]]), prefs, ...over });
const msg = (over = {}) => ({ authorId: "u2", authorName: "Maya", serverId: "s1", channelId: "c1", content: "hi", mentions: [], mentionsEveryone: false, ...over });

test("only messages meant for me notify", () => {
  assert.strictEqual(classify(msg(), ctx()), null);
  assert.strictEqual(classify(msg({ serverId: "dm1" }), ctx()), "dm");
  assert.strictEqual(classify(msg({ mentions: ["me"] }), ctx()), "mention");
  assert.strictEqual(classify(msg({ mentionsEveryone: true }), ctx()), "everyone");
});

test("my own messages, do not disturb and switched-off kinds stay quiet", () => {
  assert.strictEqual(classify(msg({ authorId: "me", mentions: ["me"] }), ctx()), null);
  assert.strictEqual(classify(msg({ mentions: ["me"] }), ctx({ presence: "dnd" })), null);
  assert.strictEqual(classify(msg({ mentions: ["me"] }), ctx({ prefs: { ...prefs, mentions: false } })), null);
  assert.strictEqual(classify(msg({ serverId: "dm1" }), ctx({ prefs: { ...prefs, enabled: false } })), null);
});

test("popup text matches the page's", () => {
  const n = buildNote(msg({ content: "hello <:wave:123> ||secret||" }), "mention", ctx());
  assert.strictEqual(n.title, "Maya in Game Night");
  assert.strictEqual(n.body, "hello :wave: [spoiler]");
  assert.deepStrictEqual(n.target, { serverId: "s1", channelId: "c1" });
  assert.strictEqual(buildNote(msg({ serverId: "dm1" }), "dm", ctx()).title, "Maya");
  assert.strictEqual(buildNote(msg({ content: "secret" }), "mention", ctx({ prefs: { ...prefs, preview: false } })).body, "Mentioned you");
  assert.strictEqual(buildNote(msg({ content: "", gif: "x" }), "mention", ctx()).body, "Sent a GIF");
  assert.strictEqual(plain("  a \n b  "), "a b");
});
