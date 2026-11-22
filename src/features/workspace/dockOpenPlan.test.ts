import assert from "node:assert/strict";
import test from "node:test";

import { planDockOpen } from "./dockOpenPlan.ts";

test("the connection that is already open is left alone", () => {
  assert.equal(planDockOpen("a", null, true, "a"), "ignore");
});

test("nothing is started while another connection is being opened", () => {
  assert.equal(planDockOpen(null, "b", true, "a"), "ignore");
});

test("a deleted connection is reported, not opened", () => {
  assert.equal(planDockOpen(null, null, false, "a"), "missing");
  assert.equal(planDockOpen("b", null, false, "a"), "missing");
});

test("from the welcome screen it is opened; from another connection it is switched to", () => {
  assert.equal(planDockOpen(null, null, true, "a"), "connect");
  assert.equal(planDockOpen("b", null, true, "a"), "switch");
});
