/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ImportPreview, ImportStatus } from "../../bindings.ts";
import {
  autoMapping,
  columnNameOf,
  defaultImportForm,
  errorsText,
  formProblem,
  guessFormat,
  mappingList,
  newColumns,
  progressOf,
  tableNameOf,
  toRequest,
} from "./importOptions.ts";

test("the file's name suggests the format", () => {
  assert.deepEqual(guessFormat("/a/people.csv"), { format: "csv", delimiter: "," });
  assert.deepEqual(guessFormat("/a/people.TSV"), { format: "csv", delimiter: "\t" });
  assert.deepEqual(guessFormat("/a/people.ndjson"), { format: "json", delimiter: "," });
  assert.deepEqual(guessFormat("/a/people.json"), { format: "json", delimiter: "," });
  assert.deepEqual(guessFormat("/a/people.txt"), { format: "csv", delimiter: "," });
  assert.deepEqual(guessFormat("/a/noextension"), { format: "csv", delimiter: "," });
});

test("a table name from a file name", () => {
  assert.equal(tableNameOf("/Users/me/Orders 2026.csv"), "orders_2026");
  assert.equal(tableNameOf("/x/2026 sales.csv"), "t_2026_sales");
  assert.equal(tableNameOf("/x/---.csv"), "imported");
  assert.equal(tableNameOf("plain"), "plain");
});

test("columns are matched by name, case and spaces aside, each table column once", () => {
  assert.deepEqual(autoMapping(["ID", " Name ", "extra", "name"], ["id", "name", "note"]), {
    ID: "id",
    " Name ": "name",
    extra: null,
    name: null,
  });
  assert.deepEqual(mappingList({ a: "x", b: null, c: "y" }), [
    { source: "a", column: "x" },
    { source: "c", column: "y" },
  ]);
});

test("column names for a new table are usable and unique", () => {
  assert.equal(columnNameOf("First Name", []), "first_name");
  assert.equal(columnNameOf("2026", []), "c_2026");
  assert.equal(columnNameOf("???", []), "column");
  assert.equal(columnNameOf("id", ["id", "id_2"]), "id_3");
  const preview: ImportPreview = {
    columns: ["ID", "Name", "id"],
    rows: [],
    suggestedTypes: ["integer", "text"],
    fileBytes: 1,
    moreRows: false,
  };
  assert.deepEqual(newColumns(preview), [
    { source: "ID", name: "id", typeName: "integer" },
    { source: "Name", name: "name", typeName: "text" },
    { source: "id", name: "id_2", typeName: "text" }, // no suggestion: text
  ]);
});

test("what is wrong with the form", () => {
  const form = defaultImportForm;
  assert.match(formProblem(form, 0, []) ?? "", /Map at least one/);
  assert.equal(formProblem(form, 2, []), null);
  const fresh = { ...form, intoExisting: false };
  const col = (name: string, typeName = "text") => ({ source: name, name, typeName });
  assert.match(formProblem(fresh, 0, [col("a")]) ?? "", /name the new table|Give the new table/);
  const named = { ...fresh, newTable: "people" };
  assert.equal(formProblem(named, 0, [col("a"), col("b")]), null);
  assert.match(formProblem(named, 0, [col("a"), col("a")]) ?? "", /same name/);
  assert.match(formProblem(named, 0, [col(" ")]) ?? "", /needs a name/);
  assert.match(formProblem(named, 0, [col("a", " ")]) ?? "", /needs a type/);
});

test("the request follows the form", () => {
  const existing = toRequest(
    "/f.csv",
    { ...defaultImportForm, truncate: true, skipBadRows: true, nullText: "\\N" },
    "public",
    "users",
    { a: "id", b: null },
    [],
  );
  assert.deepEqual(existing, {
    path: "/f.csv",
    format: { kind: "csv", delimiter: ",", quote: '"', header: true, nullText: "\\N" },
    onError: "skip",
    target: {
      kind: "existing",
      schema: "public",
      table: "users",
      mapping: [{ source: "a", column: "id" }],
      truncate: true,
    },
  });
  const fresh = toRequest(
    "/f.json",
    { ...defaultImportForm, format: "json", intoExisting: false, newTable: " people " },
    "public",
    "ignored",
    {},
    [{ source: "a", name: " a ", typeName: " integer " }],
  );
  assert.deepEqual(fresh.format, { kind: "json" });
  assert.equal(fresh.onError, "abort");
  assert.deepEqual(fresh.target, {
    kind: "new",
    schema: "public",
    table: "people",
    columns: [{ source: "a", name: "a", typeName: "integer" }],
  });
});

const status = (patch: Partial<ImportStatus>): ImportStatus => ({
  state: "running",
  rowsRead: 0,
  rowsWritten: 0,
  rowsSkipped: 0,
  bytesRead: 0,
  bytesTotal: 0,
  errors: [],
  moreErrors: false,
  error: null,
  table: null,
  ...patch,
});

test("progress is the share of the file read, never full before it is done", () => {
  assert.deepEqual(progressOf(status({ rowsRead: 5000, bytesRead: 250, bytesTotal: 1000 })), {
    fraction: 0.25,
    text: "5,000 rows read",
  });
  assert.equal(progressOf(status({ bytesRead: 1000, bytesTotal: 1000 })).fraction, 0.99);
  assert.equal(progressOf(status({ state: "done", bytesTotal: 10 })).fraction, 1);
  assert.equal(progressOf(status({})).fraction, 0);
  assert.equal(progressOf(status({ rowsRead: 1 })).text, "1 row read");
});

test("the errors as text", () => {
  const s = status({
    errors: [
      { at: "line 6", message: "bad" },
      { at: "line 9", message: "worse" },
    ],
    moreErrors: true,
  });
  assert.equal(errorsText(s), "line 6: bad\nline 9: worse\n… and more");
  assert.equal(errorsText(status({})), "");
});
