import assert from "node:assert/strict";
import test from "node:test";

import { frontAfterClose, railLabel } from "./rail.ts";

test("closing a connection brings the next one forward, else the previous one", () => {
  assert.equal(frontAfterClose(["a", "b", "c"], "b"), "c");
  assert.equal(frontAfterClose(["a", "b", "c"], "c"), "b");
  assert.equal(frontAfterClose(["a", "b"], "a"), "b");
});

test("closing the only connection leaves none", () => {
  assert.equal(frontAfterClose(["a"], "a"), null);
  assert.equal(frontAfterClose(["a"], "zzz"), null);
});

test("the strip label is one short line", () => {
  assert.equal(railLabel("hrm_local"), "hrm_local");
  assert.equal(railLabel("  my   prod\nsrv "), "my prod srv");
  assert.equal(railLabel("a very long connection name").length, 12);
  assert.ok(railLabel("a very long connection name").endsWith("…"));
});
