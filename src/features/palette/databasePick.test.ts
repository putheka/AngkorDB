import assert from "node:assert/strict";
import test from "node:test";

import { pushName, recentDatabases } from "./databasePick.ts";

test("the newest database comes first, once, and only a few are kept", () => {
  assert.deepEqual(pushName([], "a"), ["a"]);
  assert.deepEqual(pushName(["a", "b", "c"], "c"), ["c", "a", "b"]);
  assert.deepEqual(pushName(["a", "b", "c", "d", "e"], "f"), ["f", "a", "b", "c", "d"]);
  assert.deepEqual(pushName(["a", "b"], "x", 2), ["x", "a"]);
});

test("recent databases that were dropped, or are open now, are left out", () => {
  const all = ["a", "b", "c", "postgres"];
  assert.deepEqual(recentDatabases(["gone", "b", "postgres", "a"], all, "postgres"), ["b", "a"]);
  assert.deepEqual(recentDatabases([], all, "a"), []);
  assert.deepEqual(recentDatabases(["b"], all, undefined), ["b"]);
});
