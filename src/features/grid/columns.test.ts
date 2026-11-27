/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_LAYOUT, matchColumns, withHidden } from "./columns.ts";

const columns = [
  { name: "id", typeName: "bigint" },
  { name: "packageable_type", typeName: "character varying(255)" },
  { name: "packageable_id", typeName: "bigint" },
  { name: "total_price", typeName: "numeric(20,6)" },
  { name: "created_at", typeName: "timestamp with time zone" },
];

test("an empty search keeps every column", () => {
  assert.equal(matchColumns(columns, ""), columns);
  assert.equal(matchColumns(columns, "   "), columns);
});

test("search looks at the name and the type, ignoring case", () => {
  assert.deepEqual(
    matchColumns(columns, "PACKAGEABLE").map((c) => c.name),
    ["packageable_type", "packageable_id"],
  );
  assert.deepEqual(
    matchColumns(columns, "bigint").map((c) => c.name),
    ["id", "packageable_id"],
  );
});

test("every word of the search has to match", () => {
  assert.deepEqual(
    matchColumns(columns, "packageable bigint").map((c) => c.name),
    ["packageable_id"],
  );
  assert.deepEqual(matchColumns(columns, "packageable nothing"), []);
});

test("hiding and showing only touch the named columns", () => {
  const layout = { ...EMPTY_LAYOUT, hidden: ["a", "b"] };
  assert.deepEqual(withHidden(layout, ["c", "d"], true).hidden, ["a", "b", "c", "d"]);
  assert.deepEqual(withHidden(layout, ["b", "x"], false).hidden, ["a"]);
});

test("hiding a column that is already hidden does not list it twice", () => {
  const layout = { ...EMPTY_LAYOUT, hidden: ["a"] };
  assert.deepEqual(withHidden(layout, ["a", "b"], true).hidden, ["a", "b"]);
});
