/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatBytes, formatCompact, formatDuration, formatRowCount } from "./format.ts";

test("sizes use binary units with a digit only when it helps", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(812), "812 B");
  assert.equal(formatBytes(1024), "1 KB");
  assert.equal(formatBytes(8192), "8 KB");
  assert.equal(formatBytes(16 * 1024 + 100), "16 KB");
  assert.equal(formatBytes(16 * 1024 + 700), "17 KB");
  assert.equal(formatBytes(2.4 * 1024 * 1024), "2.4 MB");
  assert.equal(formatBytes(120 * 1024 * 1024), "120 MB");
  assert.equal(formatBytes(1.2 * 1024 ** 3), "1.2 GB");
  assert.equal(formatBytes(5 * 1024 ** 4), "5 TB");
});

test("a size that is not there reads as unknown", () => {
  assert.equal(formatBytes(null), "unknown");
  assert.equal(formatBytes(Number.NaN), "unknown");
  assert.equal(formatBytes(-1), "unknown");
});

test("the older formatters still say what they said", () => {
  assert.equal(formatRowCount(1, true), "1 row");
  assert.equal(formatRowCount(205, true), "205 rows");
  assert.equal(formatDuration(850), "850 ms");
  assert.equal(formatDuration(125_000), "2 min 5 s");
  assert.equal(formatCompact(12_345), "12.3K");
});
