/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  blankColumn,
  confirmationMatches,
  formProblems,
  needsTypedConfirmation,
  presetColumn,
  toOperation,
} from "./createTable.ts";

test("the presets fill a column the way they say", () => {
  const id = presetColumn("id", 1);
  assert.deepEqual(
    { n: id.name, t: id.typeName, i: id.identity, k: id.primaryKey, nullable: id.nullable },
    { n: "id", t: "bigint", i: "always", k: true, nullable: false },
  );
  const created = presetColumn("created_at", 2);
  assert.equal(created.typeName, "timestamp with time zone");
  assert.equal(created.defaultValue, "now()");
  assert.equal(created.nullable, false);
  assert.equal(presetColumn("updated_at", 3).name, "updated_at");
});

test("the form becomes an operation: trimmed, a key is never null, identity has no default", () => {
  const op = toOperation("public", " events ", "", [
    presetColumn("id", 1),
    { ...blankColumn(2), name: " name ", typeName: " text ", nullable: true, comment: "Who" },
    { ...blankColumn(3), name: "n", typeName: "integer", identity: "byDefault", defaultValue: "5" },
  ]);
  assert.ok(op.kind === "createTable");
  assert.equal(op.name, "events");
  assert.equal(op.comment, null);
  assert.deepEqual(op.columns[0], {
    name: "id",
    typeName: "bigint",
    nullable: false,
    defaultValue: null,
    identity: "always",
    primaryKey: true,
    comment: null,
  });
  assert.equal(op.columns[1]?.name, "name");
  assert.equal(op.columns[1]?.typeName, "text");
  assert.equal(op.columns[1]?.comment, "Who");
  // The default of an identity column is dropped rather than sent.
  assert.equal(op.columns[2]?.defaultValue, null);
  assert.equal(op.columns[2]?.identity, "byDefault");
  // A column that is part of the key can't allow null.
  const keyed = toOperation("s", "t", "c", [{ ...blankColumn(1), name: "a", primaryKey: true }]);
  assert.ok(keyed.kind === "createTable");
  assert.equal(keyed.columns[0]?.nullable, false);
  assert.equal(keyed.comment, "c");
});

test("problems are found before asking for the SQL", () => {
  assert.deepEqual(formProblems("t", [presetColumn("id", 1)]), []);
  assert.deepEqual(formProblems("", []), ["Give the table a name.", "Add at least one column."]);
  const found = formProblems("t", [
    { ...blankColumn(1), name: "a" },
    { ...blankColumn(2), name: "a", typeName: "" },
    { ...blankColumn(3), name: "" },
    { ...blankColumn(4), name: "b", typeName: "text", identity: "always" },
    { ...blankColumn(5), name: "c", typeName: "integer", identity: "always", defaultValue: "1" },
  ]);
  assert.ok(found.includes('Two columns are called "a".'), found.join("|"));
  assert.ok(found.includes('Column "a" has no type.'));
  assert.ok(found.includes("A column has no name."));
  assert.ok(found.includes('Column "b": only smallint, integer and bigint can be an identity.'));
  assert.ok(found.includes('Column "c": an identity column can\'t also have a default.'));
  for (const type of ["smallint", "integer", "bigint", "int", "int4", "INT8"]) {
    assert.deepEqual(
      formProblems("t", [{ ...blankColumn(1), name: "a", typeName: type, identity: "always" }]),
      [],
      type,
    );
  }
});

test("a red connection asks for the name before something is thrown away", () => {
  assert.equal(needsTypedConfirmation("red", true), true);
  assert.equal(needsTypedConfirmation("red", false), false);
  assert.equal(needsTypedConfirmation("green", true), false);
  assert.equal(needsTypedConfirmation("none", true), false);
  assert.equal(confirmationMatches(" orders ", "orders"), true);
  assert.equal(confirmationMatches("Orders", "orders"), false);
  assert.equal(confirmationMatches("", "orders"), false);
});
