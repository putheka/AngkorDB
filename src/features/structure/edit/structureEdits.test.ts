/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StructureColumn } from "../../../bindings.ts";
import {
  addNewColumn,
  addNewConstraint,
  addNewIndex,
  describeEdits,
  editColumn,
  editCount,
  EMPTY_EDITS,
  finalColumnNames,
  parseIndexColumns,
  problems,
  quoteIfNeeded,
  removeNewColumn,
  revertColumn,
  splitTopLevel,
  suggestUsing,
  toChanges,
  toggleDropColumn,
  toggleDropConstraint,
  toggleDropIndex,
  updateNewColumn,
} from "./structureEdits.ts";

function column(name: string, extra: Partial<StructureColumn> = {}): StructureColumn {
  return {
    position: 1,
    name,
    typeName: "text",
    nullable: true,
    defaultValue: null,
    identity: null,
    generated: null,
    collation: null,
    comment: null,
    isPrimaryKey: false,
    foreignKeys: [],
    ...extra,
  };
}

const status = column("status", { defaultValue: "'pending'::text", comment: "State" });

test("an edit that puts everything back leaves nothing staged", () => {
  let edits = editColumn(EMPTY_EDITS, status, { name: "state", nullable: false });
  assert.deepEqual(edits.columns, { status: { name: "state", nullable: false } });
  edits = editColumn(edits, status, { name: "status", nullable: true });
  assert.deepEqual(edits.columns, {});
  assert.equal(editCount(edits), 0);
});

test("a default is compared with the one the column has; empty means no default", () => {
  const same = editColumn(EMPTY_EDITS, status, { defaultValue: "'pending'::text" });
  assert.deepEqual(same.columns, {});
  const dropped = editColumn(EMPTY_EDITS, status, { defaultValue: "  " });
  assert.deepEqual(dropped.columns, { status: { defaultValue: null } });
  // A column with no default stays untouched when it is left empty.
  assert.deepEqual(editColumn(EMPTY_EDITS, column("note"), { defaultValue: "" }).columns, {});
  const set = editColumn(EMPTY_EDITS, column("note"), { defaultValue: " now() " });
  assert.deepEqual(set.columns, { note: { defaultValue: "now()" } });
});

test("a USING only stays with a type change", () => {
  let edits = editColumn(EMPTY_EDITS, status, { typeName: "integer", using: "status::integer" });
  assert.deepEqual(edits.columns, { status: { typeName: "integer", using: "status::integer" } });
  edits = editColumn(edits, status, { typeName: "text" });
  assert.deepEqual(edits.columns, {}, "back to the old type: the USING goes too");
});

test("comments: clearing, setting, and unchanged", () => {
  assert.deepEqual(editColumn(EMPTY_EDITS, status, { comment: "" }).columns, {
    status: { comment: null },
  });
  assert.deepEqual(editColumn(EMPTY_EDITS, status, { comment: "State" }).columns, {});
  assert.deepEqual(editColumn(EMPTY_EDITS, status, { comment: "New" }).columns, {
    status: { comment: "New" },
  });
  assert.deepEqual(editColumn(EMPTY_EDITS, column("x"), { comment: "" }).columns, {});
});

test("reverting a column and toggling drops", () => {
  let edits = editColumn(EMPTY_EDITS, status, { nullable: false });
  edits = revertColumn(edits, "status");
  assert.equal(editCount(edits), 0);
  edits = toggleDropColumn(edits, "note");
  assert.deepEqual(edits.droppedColumns, ["note"]);
  edits = toggleDropColumn(edits, "note");
  assert.deepEqual(edits.droppedColumns, []);
  edits = toggleDropIndex(toggleDropConstraint(edits, "c"), "i");
  assert.equal(editCount(edits), 2);
});

test("a dropped column's edits are not saved, and not counted", () => {
  let edits = editColumn(EMPTY_EDITS, status, { nullable: false });
  edits = toggleDropColumn(edits, "status");
  assert.equal(editCount(edits), 1);
  assert.deepEqual(
    toChanges(edits).map((c) => c.kind),
    ["dropColumn"],
  );
});

test("the changes come in an order that works", () => {
  let edits = EMPTY_EDITS;
  edits = addNewConstraint(edits, {
    id: 2,
    kind: "unique",
    name: "",
    columns: ["slug"],
  });
  edits = addNewIndex(edits, {
    id: 1,
    name: "idx_slug",
    method: "btree",
    columns: [{ text: "slug", isExpression: false, descending: false }],
    unique: false,
    whereClause: "",
    concurrently: false,
  });
  edits = addNewColumn(edits, {
    id: 3,
    name: " slug ",
    typeName: " text ",
    nullable: false,
    defaultValue: "'x'",
    comment: "",
  });
  edits = toggleDropColumn(edits, "old");
  edits = editColumn(edits, status, {
    name: "state",
    typeName: "integer",
    using: "status::integer",
  });
  edits = toggleDropIndex(edits, "idx_old");
  edits = toggleDropConstraint(edits, "con_old");

  const changes = toChanges(edits);
  assert.deepEqual(
    changes.map((c) => c.kind),
    [
      "dropConstraint",
      "dropIndex",
      "alterColumn",
      "dropColumn",
      "addColumn",
      "createIndex",
      "addUnique",
    ],
  );
  const alter = changes[2];
  assert.ok(alter?.kind === "alterColumn");
  assert.deepEqual(
    { ...alter },
    {
      kind: "alterColumn",
      column: "status",
      newName: "state",
      typeName: "integer",
      using: "status::integer",
      nullable: null,
      defaultValue: null,
      comment: null,
    },
  );
  const added = changes[4];
  assert.ok(added?.kind === "addColumn");
  assert.deepEqual(
    { ...added },
    {
      kind: "addColumn",
      name: "slug",
      typeName: "text",
      nullable: false,
      defaultValue: "'x'",
      comment: null,
    },
  );
  const unique = changes[6];
  assert.ok(unique?.kind === "addUnique");
  assert.equal(unique.name, null, "an empty name is left to the server");
});

test("default and comment changes become set and drop", () => {
  const edits = editColumn(EMPTY_EDITS, status, { defaultValue: "", comment: "" });
  const [change] = toChanges(edits);
  assert.ok(change?.kind === "alterColumn");
  assert.deepEqual(change.defaultValue, { kind: "drop" });
  assert.deepEqual(change.comment, { kind: "clear" });
  const set = toChanges(editColumn(EMPTY_EDITS, status, { defaultValue: "'x'", comment: "Hi" }));
  const [setChange] = set;
  assert.ok(setChange?.kind === "alterColumn");
  assert.deepEqual(setChange.defaultValue, { kind: "set", expression: "'x'" });
  assert.deepEqual(setChange.comment, { kind: "set", text: "Hi" });
});

test("foreign keys carry their target and actions", () => {
  const edits = addNewConstraint(EMPTY_EDITS, {
    id: 1,
    kind: "foreignKey",
    name: "fk",
    columns: ["user_id"],
    refSchema: "public",
    refTable: "users",
    refColumns: ["id"],
    onDelete: "cascade",
    onUpdate: "noAction",
    notValid: true,
  });
  const [change] = toChanges(edits);
  assert.ok(change?.kind === "addForeignKey");
  assert.equal(change.refTable, "users");
  assert.equal(change.onDelete, "cascade");
  assert.equal(change.notValid, true);
});

test("new columns can be edited and taken out again", () => {
  let edits = addNewColumn(EMPTY_EDITS, {
    id: 7,
    name: "",
    typeName: "text",
    nullable: true,
    defaultValue: "",
    comment: "",
  });
  edits = updateNewColumn(edits, 7, { name: "added", nullable: false });
  assert.equal(edits.newColumns[0]?.name, "added");
  assert.equal(edits.newColumns[0]?.nullable, false);
  edits = removeNewColumn(edits, 7);
  assert.equal(editCount(edits), 0);
});

test("the description reads like a sentence", () => {
  assert.equal(describeEdits(EMPTY_EDITS), "");
  let edits = editColumn(EMPTY_EDITS, status, { nullable: false });
  assert.equal(describeEdits(edits), "1 column changed");
  edits = toggleDropIndex(toggleDropIndex(edits, "a"), "b");
  edits = toggleDropColumn(edits, "z");
  assert.equal(describeEdits(edits), "1 column changed · 1 column dropped · 2 indexes dropped");
});

test("the column names after saving include renames and new columns, not dropped ones", () => {
  const columns = [column("a"), column("b"), column("c")];
  let edits = editColumn(EMPTY_EDITS, columns[0] as StructureColumn, { name: "alpha" });
  edits = toggleDropColumn(edits, "b");
  edits = addNewColumn(edits, {
    id: 1,
    name: "d",
    typeName: "text",
    nullable: true,
    defaultValue: "",
    comment: "",
  });
  assert.deepEqual(finalColumnNames(columns, edits), ["alpha", "c", "d"]);
});

test("mistakes are found before asking for the SQL", () => {
  const columns = [column("a"), column("b")];
  assert.deepEqual(problems(EMPTY_EDITS, columns), []);
  let edits = addNewColumn(EMPTY_EDITS, {
    id: 1,
    name: "a",
    typeName: "",
    nullable: true,
    defaultValue: "",
    comment: "",
  });
  edits = addNewColumn(edits, {
    id: 2,
    name: "  ",
    typeName: "text",
    nullable: true,
    defaultValue: "",
    comment: "",
  });
  const found = problems(edits, columns);
  assert.ok(found.includes('Two columns would be called "a".'), found.join("|"));
  assert.ok(found.includes('The new column "a" has no type.'));
  assert.ok(found.includes("A new column has no name."));
  // Renaming one onto the other is caught too.
  const renamed = editColumn(EMPTY_EDITS, columns[0] as StructureColumn, { name: "b" });
  assert.deepEqual(problems(renamed, columns), ['Two columns would be called "b".']);
});

test("commas inside brackets and quotes do not split", () => {
  assert.deepEqual(splitTopLevel("a, lower(b, c), \"d,e\", 'x,y'"), [
    "a",
    "lower(b, c)",
    '"d,e"',
    "'x,y'",
  ]);
  assert.deepEqual(splitTopLevel("  "), []);
});

test("index columns: names, quoted names, expressions and directions", () => {
  assert.deepEqual(
    parseIndexColumns('user_id, lower(email) DESC, "Odd ""Name""" asc, created_at desc'),
    [
      { text: "user_id", isExpression: false, descending: false },
      { text: "lower(email)", isExpression: true, descending: true },
      { text: 'Odd "Name"', isExpression: false, descending: false },
      { text: "created_at", isExpression: false, descending: true },
    ],
  );
  assert.deepEqual(parseIndexColumns("(a + b)"), [
    { text: "(a + b)", isExpression: true, descending: false },
  ]);
  assert.deepEqual(parseIndexColumns(""), []);
});

test("names are quoted only when they have to be", () => {
  assert.equal(quoteIfNeeded("status"), "status");
  assert.equal(quoteIfNeeded("Status"), '"Status"');
  assert.equal(quoteIfNeeded("two words"), '"two words"');
  assert.equal(quoteIfNeeded('we"ird'), '"we""ird"');
  assert.equal(suggestUsing("status", " integer "), "status::integer");
  assert.equal(suggestUsing("Order Id", "bigint"), '"Order Id"::bigint');
});
