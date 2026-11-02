import test from "node:test";
import assert from "node:assert";
import { effectiveStatus } from "../src/idlestatus";

const idle = (...ids: string[]) => new Set(ids);

test("nobody connected is offline, and invisible always looks offline", () => {
  assert.strictEqual(effectiveStatus("online", [], idle()), "offline");
  assert.strictEqual(effectiveStatus("invisible", ["a"], idle()), "offline");
  assert.strictEqual(effectiveStatus("invisible", ["a"], idle("a")), "offline");
});
test("online with an active connection stays online", () => {
  assert.strictEqual(effectiveStatus("online", ["a"], idle()), "online");
});
test("online with every connection idle looks idle", () => {
  assert.strictEqual(effectiveStatus("online", ["a"], idle("a")), "idle");
  assert.strictEqual(effectiveStatus("online", ["a", "b"], idle("a", "b")), "idle");
});
test("one active device (a phone, another tab) keeps someone online", () => {
  assert.strictEqual(effectiveStatus("online", ["desktop", "phone"], idle("desktop")), "online");
});
test("a chosen status is never overridden by being idle", () => {
  assert.strictEqual(effectiveStatus("dnd", ["a"], idle("a")), "dnd");
  assert.strictEqual(effectiveStatus("idle", ["a"], idle()), "idle");
});
test("idle flags for connections that are gone don't matter", () => {
  assert.strictEqual(effectiveStatus("online", ["a"], idle("gone")), "online");
});
