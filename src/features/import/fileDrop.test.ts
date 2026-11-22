import assert from "node:assert/strict";
import test from "node:test";

import { chooseDropped, dropPrompt, dropTarget, isImportable, refusal } from "./fileDrop.ts";

test("data files are importable, whatever the case, and nothing else is", () => {
  for (const f of ["/a/b.csv", "/a/B.CSV", "/a/x.tsv", "/a/x.json", "/a/x.NDJSON", "/a/x.jsonl"]) {
    assert.ok(isImportable(f), f);
  }
  for (const f of ["/a/b.sql", "/a/b", "/a/.csv", "/a.d/csv", "/a/b.csv.zip", "/a/b.png"]) {
    assert.ok(!isImportable(f), f);
  }
});

test("the first importable file is taken and the rest are counted as left", () => {
  assert.deepEqual(chooseDropped(["/a/x.png", "/a/y.csv", "/a/z.json"]), {
    path: "/a/y.csv",
    left: 2,
  });
  assert.deepEqual(chooseDropped(["/a/y.csv"]), { path: "/a/y.csv", left: 0 });
  assert.deepEqual(chooseDropped(["/a/x.png", "/a/y.sql"]), { path: null, left: 2 });
  assert.deepEqual(chooseDropped([]), { path: null, left: 0 });
});

test("a file goes into the table in front, or becomes a new table", () => {
  const table = { kind: "table", schema: "sales", name: "orders", objectKind: "table" };
  assert.deepEqual(dropTarget(table, "public"), { schema: "sales", table: "orders" });
  assert.deepEqual(dropTarget({ ...table, objectKind: "partitionedTable" }, null), {
    schema: "sales",
    table: "orders",
  });
  // Views and foreign tables can't be imported into; neither can other tabs, or none.
  assert.deepEqual(dropTarget({ ...table, objectKind: "view" }, "app"), {
    schema: "app",
    table: null,
  });
  assert.deepEqual(dropTarget({ kind: "query" }, null), { schema: "public", table: null });
  assert.deepEqual(dropTarget(null, "app"), { schema: "app", table: null });
});

test("the prompts say where the file goes and why it can't", () => {
  assert.equal(dropPrompt({ schema: "s", table: "t" }), "Drop to import into s.t");
  assert.equal(dropPrompt({ schema: "s", table: null }), "Drop to import as a new table in s");
  assert.match(refusal(["/a.png"]), /That file/);
  assert.match(refusal(["/a.png", "/b.png"]), /None of those/);
});
