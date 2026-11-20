/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ColumnInfo } from "../../bindings.ts";
import {
  foreignKeyColumns,
  foreignKeyGroups,
  groupOf,
  referencedValues,
  tableLabel,
} from "./foreignKeys.ts";

type Ref = ColumnInfo["foreignKeys"][number];

/** Just the parts of a column that foreign keys look at. */
function column(name: string, foreignKeys: Ref[] = []): ColumnInfo {
  return { name, foreignKeys } as unknown as ColumnInfo;
}
const ref = (constraint: string, table: string, target: string, schema = "public"): Ref => ({
  constraint,
  schema,
  table,
  column: target,
});

test("a single-column key is a group of one", () => {
  const groups = foreignKeyGroups([
    column("id"),
    column("user_id", [ref("orders_user_id_fkey", "users", "id")]),
  ]);
  assert.deepEqual(groups, [
    {
      constraint: "orders_user_id_fkey",
      schema: "public",
      table: "users",
      pairs: [{ column: "user_id", target: "id" }],
    },
  ]);
  assert.deepEqual([...foreignKeyColumns(groups)], ["user_id"]);
});

test("a composite key is one group with every column, whatever order the table lists them in", () => {
  // child (id, y, x) with FOREIGN KEY (x, y) REFERENCES parent (a, b)
  const groups = foreignKeyGroups([
    column("id"),
    column("y", [ref("child_fk", "parent", "b")]),
    column("x", [ref("child_fk", "parent", "a")]),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    [...(groups[0]?.pairs ?? [])].sort((p, q) => p.column.localeCompare(q.column)),
    [
      { column: "x", target: "a" },
      { column: "y", target: "b" },
    ],
  );
  // Either column leads to the same group.
  assert.equal(groupOf(groups, "x"), groupOf(groups, "y"));
  assert.equal(groupOf(groups, "id"), undefined);
});

test("two keys to the same table stay two groups; same constraint name in two tables does not merge", () => {
  const groups = foreignKeyGroups([
    column("author_id", [ref("posts_author_fkey", "people", "id")]),
    column("editor_id", [ref("posts_editor_fkey", "people", "id")]),
    column("org_id", [ref("posts_author_fkey", "orgs", "id", "billing")]),
  ]);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((g) => `${g.schema}.${g.table}/${g.constraint}`),
    [
      "public.people/posts_author_fkey",
      "public.people/posts_editor_fkey",
      "billing.orgs/posts_author_fkey",
    ],
  );
});

test("a table with no keys has no groups", () => {
  assert.deepEqual(foreignKeyGroups([column("a"), column("b")]), []);
});

test("referenced values: all of them, or nothing when one is NULL", () => {
  const fk = {
    constraint: "c",
    schema: "public",
    table: "child",
    columns: ["x", "y"],
    referencedColumns: ["a", "b"],
  };
  const row: Record<string, string | null> = { a: "1", b: "2" };
  assert.deepEqual(
    referencedValues(fk, (c) => row[c] ?? null),
    ["1", "2"],
  );
  row["b"] = null;
  assert.equal(
    referencedValues(fk, (c) => row[c] ?? null),
    null,
  );
});

test("names in another schema are qualified", () => {
  assert.equal(tableLabel("public", "orders", "public"), "orders");
  assert.equal(tableLabel("billing", "invoices", "public"), "billing.invoices");
});
