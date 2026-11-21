/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExportStatus } from "../../bindings.ts";
import {
  batchSizeOf,
  defaultExportForm,
  defaultFileName,
  extensionOf,
  folderOf,
  formProblem,
  progressOf,
  toFormat,
} from "./exportOptions.ts";

const form = (patch: Partial<typeof defaultExportForm>) => ({ ...defaultExportForm, ...patch });

test("each format becomes the request the backend wants", () => {
  assert.deepEqual(toFormat(defaultExportForm), {
    kind: "csv",
    delimiter: ",",
    quote: '"',
    header: true,
    nullText: "",
  });
  assert.deepEqual(toFormat(form({ format: "json", ndjson: true })), {
    kind: "json",
    ndjson: true,
  });
  assert.deepEqual(toFormat(form({ format: "sql", batchSize: "250" })), {
    kind: "sql",
    batchSize: 250,
  });
  assert.deepEqual(toFormat(form({ format: "markdown" })), { kind: "markdown" });
});

test("rows per INSERT: a whole number from 1; the rest is 100; never more than 10000", () => {
  assert.equal(batchSizeOf("250"), 250);
  assert.equal(batchSizeOf(" 7 "), 7);
  for (const bad of ["", "0", "-3", "1.5", "abc"]) assert.equal(batchSizeOf(bad), 100, bad);
  assert.equal(batchSizeOf("999999"), 10_000);
});

test("what is wrong with the form", () => {
  assert.equal(formProblem(defaultExportForm), null);
  assert.match(formProblem(form({ delimiter: '"' })) ?? "", /differ/);
  // The delimiter only matters for CSV.
  assert.equal(formProblem(form({ format: "json", delimiter: '"' })), null);
  assert.match(formProblem(form({ format: "sql", batchSize: "" })) ?? "", /whole number/);
  assert.match(formProblem(form({ format: "sql", batchSize: "0" })) ?? "", /whole number/);
  assert.equal(formProblem(form({ format: "sql", batchSize: "50" })), null);
});

test("file names and extensions follow the format", () => {
  assert.equal(extensionOf(defaultExportForm), "csv");
  assert.equal(extensionOf(form({ delimiter: "\t" })), "tsv");
  assert.equal(extensionOf(form({ format: "json" })), "json");
  assert.equal(extensionOf(form({ format: "json", ndjson: true })), "ndjson");
  assert.equal(extensionOf(form({ format: "sql" })), "sql");
  assert.equal(extensionOf(form({ format: "markdown" })), "md");
  assert.equal(defaultFileName("public.users", defaultExportForm), "public.users.csv");
  assert.equal(defaultFileName("we/ird:name", defaultExportForm), "we_ird_name.csv");
  assert.equal(defaultFileName("  ", form({ format: "sql" })), "export.sql");
});

const status = (patch: Partial<ExportStatus>): ExportStatus => ({
  state: "running",
  rows: 0,
  bytes: 0,
  estimatedRows: null,
  current: null,
  files: [],
  error: null,
  ...patch,
});

test("progress is a fraction of the estimate, never full before it is done", () => {
  assert.deepEqual(progressOf(status({ rows: 500, bytes: 2048, estimatedRows: 1000 })), {
    fraction: 0.5,
    text: "500 rows · 2.0 KB",
  });
  // The estimate was too low.
  assert.equal(progressOf(status({ rows: 5000, estimatedRows: 1000 })).fraction, 0.99);
  // No estimate (a filter, a query): unknown.
  assert.equal(progressOf(status({ rows: 5000 })).fraction, null);
  assert.equal(progressOf(status({ rows: 5000, estimatedRows: 0 })).fraction, null);
  assert.equal(progressOf(status({ state: "done", rows: 1, bytes: 10 })).fraction, 1);
  assert.equal(progressOf(status({ state: "done", rows: 1, bytes: 10 })).text, "1 row · 10 B");
  assert.equal(
    progressOf(status({ state: "done", rows: 1_000_000, bytes: 56 * 1024 * 1024 })).text,
    "1,000,000 rows · 56 MB",
  );
  assert.equal(
    progressOf(status({ state: "cancelled", rows: 5, estimatedRows: 10 })).fraction,
    null,
  );
});

test("the folder of a path", () => {
  assert.equal(folderOf("/Users/me/out/users.csv"), "/Users/me/out");
  assert.equal(folderOf("/users.csv"), "/users.csv");
});
