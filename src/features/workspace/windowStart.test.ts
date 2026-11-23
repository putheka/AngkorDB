import assert from "node:assert/strict";
import test from "node:test";

import { windowStart } from "./windowStart.ts";

test("the first window brings back the last connection", () => {
  assert.deepEqual(windowStart("main", ""), { kind: "restore" });
});

test("a window made later starts at the welcome screen", () => {
  assert.deepEqual(windowStart("window-2", ""), { kind: "welcome" });
});

test("a window can be asked for a connection or the new-connection form", () => {
  assert.deepEqual(windowStart("window-2", "#open=abc-123"), { kind: "open", id: "abc-123" });
  assert.deepEqual(windowStart("window-3", "#new"), { kind: "new" });
});

test("an address that names no connection is the welcome screen", () => {
  assert.deepEqual(windowStart("window-2", "#open="), { kind: "welcome" });
  assert.deepEqual(windowStart("window-2", "#open=%E0%A4%A"), { kind: "welcome" });
  assert.deepEqual(windowStart("window-2", "#whatever"), { kind: "welcome" });
});
