/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StatementResult } from "../../bindings.ts";
import { messageCount, pickTab, resultsOf, sameTab } from "./resultTabs.ts";

const range = { start: 0, end: 1 };
const rows = (n: number): StatementResult => ({
  range,
  durationMs: 1,
  notices: [],
  outcome: {
    kind: "rows",
    columns: [],
    rows: Array.from({ length: n }, () => []),
    truncated: false,
  },
});
const command: StatementResult = {
  range,
  durationMs: 1,
  notices: [],
  outcome: { kind: "command", command: "UPDATE", affected: 3 },
};
const failure: StatementResult = {
  range,
  durationMs: 1,
  notices: [],
  outcome: {
    kind: "error",
    offset: null,
    error: {
      code: "POSTGRES",
      message: "boom",
      pgCode: null,
      detail: null,
      hint: null,
      position: null,
    },
  },
};
const noticed: StatementResult = {
  ...command,
  notices: [{ severity: "NOTICE", message: "hi", detail: null, hint: null, code: "00000" }],
};

test("three selects and an update: three result tabs numbered 1 to 3, and messages (the done-when)", () => {
  const run = [rows(2), rows(0), rows(5), command];
  assert.deepEqual(resultsOf(run), [
    { index: 0, number: 1, rows: 2 },
    { index: 1, number: 2, rows: 0 },
    { index: 2, number: 3, rows: 5 },
  ]);
  // The last grid is shown; Messages has the update.
  assert.deepEqual(pickTab(run), { kind: "result", index: 2 });
});

test("a script with no rows, or one that failed, opens on Messages", () => {
  assert.deepEqual(pickTab([command, command]), { kind: "messages" });
  assert.deepEqual(pickTab([rows(1), failure]), { kind: "messages" });
  assert.deepEqual(pickTab([]), { kind: "messages" });
});

test("the badge counts notices and errors, not plain statements", () => {
  assert.equal(messageCount([rows(1), command]), 0);
  assert.equal(messageCount([noticed, noticed, failure]), 3);
});

test("tabs compare by kind and identity", () => {
  assert.ok(sameTab({ kind: "messages" }, { kind: "messages" }));
  assert.ok(sameTab({ kind: "result", index: 1 }, { kind: "result", index: 1 }));
  assert.ok(!sameTab({ kind: "result", index: 1 }, { kind: "result", index: 2 }));
  assert.ok(!sameTab({ kind: "pinned", id: 1 }, { kind: "result", index: 1 }));
  assert.ok(sameTab({ kind: "pinned", id: 7 }, { kind: "pinned", id: 7 }));
});
