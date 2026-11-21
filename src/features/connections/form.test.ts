/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyForm, secondsText, timeoutMs, validateForm } from "./form.ts";

test("the statement timeout is typed in seconds and kept in milliseconds", () => {
  assert.equal(timeoutMs("30"), 30_000);
  assert.equal(timeoutMs(" 0.5 "), 500);
  assert.equal(timeoutMs("1.2345"), 1235);
  // Blank, 0 and nonsense mean no limit; a day is the most.
  for (const none of ["", "  ", "0", "-5", "abc", "NaN"]) assert.equal(timeoutMs(none), null, none);
  assert.equal(timeoutMs("999999"), 86_400_000);

  assert.equal(secondsText(30_000), "30");
  assert.equal(secondsText(500), "0.5");
  assert.equal(secondsText(null), "");
  assert.equal(secondsText(undefined), "");
  assert.equal(secondsText(0), "");
});

test("the form refuses a timeout it can't read, and accepts none", () => {
  const filled = { ...emptyForm, user: "u", database: "d" };
  assert.deepEqual(validateForm(filled), {});
  assert.deepEqual(validateForm({ ...filled, statementTimeout: "30" }), {});
  assert.deepEqual(validateForm({ ...filled, statementTimeout: "0" }), {});
  for (const bad of ["abc", "-1", "100000"]) {
    assert.deepEqual(
      Object.keys(validateForm({ ...filled, statementTimeout: bad })),
      ["statementTimeout"],
      bad,
    );
  }
});
