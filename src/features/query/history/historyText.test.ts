/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatAgo, groupByFolder, oneLine, suggestName } from "./historyText.ts";

test("oneLine squeezes whitespace and cuts long text", () => {
  assert.equal(oneLine("SELECT *\n  FROM   orders\n"), "SELECT * FROM orders");
  assert.equal(oneLine("abcdefghij", 5), "abcde…");
  assert.equal(oneLine("   "), "");
});

test("formatAgo reads like a person would say it", () => {
  const now = 1_000_000_000_000;
  const ago = (ms: number) => formatAgo(now - ms, now);
  assert.equal(ago(5_000), "just now");
  assert.equal(ago(5 * 60_000), "5 min ago");
  assert.equal(ago(3 * 3_600_000), "3 h ago");
  assert.equal(ago(26 * 3_600_000), "yesterday");
  assert.equal(ago(4 * 86_400_000), "4 days ago");
  assert.match(ago(40 * 86_400_000), /\d{4}/);
  assert.equal(formatAgo(null, now), "");
  assert.equal(formatAgo(now + 5000, now), "just now", "a clock that is a little ahead");
});

test("groupByFolder puts the folder-less ones first and sorts folders", () => {
  const groups = groupByFolder([
    { folder: "Reports", name: "a" },
    { folder: "", name: "b" },
    { folder: "archive", name: "c" },
    { folder: "Reports", name: "d" },
  ]);
  assert.deepEqual(
    groups.map((g) => [g.folder, g.items.map((i) => i.name)]),
    [
      ["", ["b"]],
      ["archive", ["c"]],
      ["Reports", ["a", "d"]],
    ],
  );
});

test("suggestName skips comments and shortens", () => {
  assert.equal(suggestName("-- daily\nSELECT 1"), "SELECT 1");
  assert.equal(
    suggestName("/* x */ select * from a_very_long_table_name_indeed where id = 1"),
    "select * from a_very_long_table_name_ind…",
  );
});
