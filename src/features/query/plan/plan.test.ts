/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BIG_SCAN_PLAN,
  JOIN_PLAN,
  planWithoutActuals,
  UPDATE_PLAN,
} from "../../../dev/planFixtures.ts";
import { formatMs, formatShare, parsePlan, PlanError, planToText } from "./plan.ts";

const json = (value: unknown) => JSON.stringify(value);

/** The value, which the test has already shown to be there. */
function must<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, "expected a value");
  return value;
}

test("a parallel scan of a million rows is the slowest node and is flagged", () => {
  const plan = parsePlan(json(BIG_SCAN_PLAN));
  assert.equal(plan.analyzed, true);
  assert.equal(plan.basis, "time");
  assert.deepEqual(
    plan.nodes.map((n) => n.name),
    ["Finalize Aggregate", "Gather", "Partial Aggregate", "Parallel Seq Scan"],
  );

  const scan = must(plan.nodes[3]);
  assert.equal(plan.hottest, scan, "the Seq Scan did the most work itself");
  assert.equal(scan.heat, "hottest");
  assert.equal(scan.target, "metrics_big");
  assert.ok(scan.share > 0.5, `the scan is ${scan.share} of the run`);
  assert.ok(
    scan.warnings.some((w) => /Sequential scan read about [\d,]+ rows/.test(w)),
    scan.warnings.join(" | "),
  );
  // Nothing else is red.
  assert.deepEqual(
    plan.nodes.filter((n) => n.heat === "hottest").map((n) => n.name),
    ["Parallel Seq Scan"],
  );
});

test("work done by parallel workers is counted once, not once per worker", () => {
  const plan = parsePlan(json(BIG_SCAN_PLAN));
  const [aggregate, gather, partial, scan] = plan.nodes as [
    (typeof plan.nodes)[number],
    (typeof plan.nodes)[number],
    (typeof plan.nodes)[number],
    (typeof plan.nodes)[number],
  ];
  // Three loops (two workers and the leader) of the scan are one stretch of wall time.
  assert.equal(must(scan.actual).loops, 3);
  assert.ok(Math.abs(must(scan.wallMs) - must(scan.actual).totalMs) < 1e-9);
  // So the numbers add up: nothing is more than the whole run.
  const total = must(plan.executionMs);
  for (const node of plan.nodes) {
    assert.ok(must(node.exclusiveMs) <= total + 1, `${node.name}: ${node.exclusiveMs} of ${total}`);
    assert.ok(node.share >= 0 && node.share <= 1);
  }
  assert.ok(
    must(gather.exclusiveMs) >= 0 &&
      must(partial.exclusiveMs) >= 0 &&
      must(aggregate.exclusiveMs) >= 0,
  );
});

test("a join plan names its nodes like Postgres does and finds the hottest", () => {
  const plan = parsePlan(json(JOIN_PLAN));
  assert.deepEqual(
    plan.nodes.map((n) => [n.depth, n.name, n.target]),
    [
      [0, "Limit", null],
      [1, "Sort", null],
      [2, "HashAggregate", null],
      [3, "Hash Right Join", null],
      [4, "Seq Scan", "orders o"],
      [4, "Hash", null],
      [5, "Seq Scan", "users u"],
    ],
  );
  assert.equal(plan.root.name, "Limit");
  assert.equal(must(plan.hottest).heat, "hottest");
  assert.equal(plan.nodes.filter((n) => n.heat === "hottest").length, 1);
  // Rows: the estimate and what came out, per loop.
  const sort = must(plan.nodes[1]);
  assert.equal(sort.planRows, 205);
  assert.equal(must(sort.actual).rows, 10);
  // Only the hottest is red; others are at most orange.
  assert.ok(plan.nodes.every((n) => n === plan.hottest || n.heat !== "hottest"));
});

test("an update is shown as Update on its table, with no warning for a tiny table", () => {
  const plan = parsePlan(json(UPDATE_PLAN));
  assert.equal(plan.root.name, "Update");
  assert.equal(plan.root.target, "short_codes");
  assert.equal(must(plan.nodes[1]).name, "Seq Scan");
  assert.ok(
    plan.nodes.every((n) => n.warnings.length === 0),
    plan.nodes.map((n) => n.warnings).join(),
  );
  assert.match(must(planToText(plan).split("\n")[0]), /^Update on short_codes {2}\(cost=/);
});

test("a plain EXPLAIN is shown by cost, and a big scan is still flagged", () => {
  const plan = parsePlan(json(planWithoutActuals(BIG_SCAN_PLAN)));
  assert.equal(plan.analyzed, false);
  assert.equal(plan.basis, "cost");
  assert.equal(plan.executionMs, null);
  assert.ok(plan.nodes.every((n) => n.actual === null && n.exclusiveMs === null));
  assert.equal(must(plan.hottest).name, "Parallel Seq Scan");
  assert.ok(must(plan.hottest).warnings.some((w) => /high cost/.test(w)));
});

test("a bad estimate, a filter that discards, a sort on disk and a spilled hash are named", () => {
  const plan = parsePlan(
    json([
      {
        Plan: {
          "Node Type": "Sort",
          "Startup Cost": 1,
          "Total Cost": 100,
          "Plan Rows": 10,
          "Plan Width": 4,
          "Actual Startup Time": 1,
          "Actual Total Time": 50,
          "Actual Rows": 5000,
          "Actual Loops": 1,
          "Sort Method": "external merge",
          "Sort Space Used": 9000,
          "Sort Space Type": "Disk",
          Plans: [
            {
              "Node Type": "Hash Join",
              "Join Type": "Semi",
              "Parent Relationship": "Outer",
              "Startup Cost": 1,
              "Total Cost": 50,
              "Plan Rows": 5000,
              "Plan Width": 4,
              "Actual Startup Time": 1,
              "Actual Total Time": 40,
              "Actual Rows": 5000,
              "Actual Loops": 1,
              "Hash Batches": 4,
              Plans: [
                {
                  "Node Type": "Seq Scan",
                  "Parent Relationship": "Outer",
                  "Relation Name": "events",
                  Alias: "e",
                  "Startup Cost": 0,
                  "Total Cost": 20,
                  "Plan Rows": 5000,
                  "Plan Width": 4,
                  "Actual Startup Time": 0.1,
                  "Actual Total Time": 30,
                  "Actual Rows": 5000,
                  "Actual Loops": 1,
                  Filter: "(kind = 'x')",
                  "Rows Removed by Filter": 90000,
                },
              ],
            },
          ],
        },
        "Execution Time": 51,
      },
    ]),
  );
  const [sort, join, scan] = plan.nodes as [
    (typeof plan.nodes)[number],
    (typeof plan.nodes)[number],
    (typeof plan.nodes)[number],
  ];
  assert.equal(join.name, "Hash Semi Join");
  assert.equal(scan.target, "events e");
  assert.ok(sort.warnings.some((w) => /disk/.test(w)));
  assert.equal(sort.estimateOff, 500);
  assert.ok(sort.warnings.some((w) => /expected 10 rows/.test(w)));
  assert.ok(join.warnings.some((w) => /4 batches/.test(w)));
  assert.ok(scan.warnings.some((w) => /threw away 90,000 rows/.test(w)));
  assert.ok(scan.warnings.some((w) => /Sequential scan read about 95,000/.test(w)) === false);
});

test("the text plan looks like EXPLAIN's own", () => {
  const text = planToText(parsePlan(json(BIG_SCAN_PLAN)));
  const lines = text.split("\n");
  assert.match(
    must(lines[0]),
    /^Finalize Aggregate {2}\(cost=[\d.]+\.\.[\d.]+ rows=1 width=8\) \(actual time=[\d.]+\.\.[\d.]+ rows=1 loops=1\)$/,
  );
  assert.equal(lines[1], "  Buffers: shared hit=5803 read=2537");
  assert.match(text, /\n {2}-> {2}Gather {2}\(cost=/);
  assert.match(text, /\n {20}Rows Removed by Filter: 333303\n/);
  assert.match(text, /\n {8}Workers Planned: 2\n/);
  assert.match(text, /\n {8}-> {2}Partial Aggregate {2}\(cost=/);
  assert.match(text, /\n {14}-> {2}Parallel Seq Scan on metrics_big {2}\(cost=/);
  assert.match(text, /\n {20}Filter: /);
  assert.match(text, /\nPlanning Time: [\d.]+ ms\nExecution Time: [\d.]+ ms$/);
});

test("things that are not a plan are refused with a clear message", () => {
  for (const bad of ["", "not json", "[]", "{}", '[{"nope": 1}]', "42"]) {
    assert.throws(() => parsePlan(bad), PlanError, bad);
  }
});

test("times and shares are written for people", () => {
  assert.equal(formatMs(0.004), "< 0.01 ms");
  assert.equal(formatMs(0.123), "0.12 ms");
  assert.equal(formatMs(24.5), "24.5 ms");
  assert.equal(formatMs(24), "24 ms");
  assert.equal(formatMs(312.4), "312 ms");
  assert.equal(formatMs(1500), "1.5 s");
  assert.equal(formatMs(125_000), "2 min 5 s");
  assert.equal(formatShare(0), "0%");
  assert.equal(formatShare(0.004), "< 1%");
  assert.equal(formatShare(0.824), "82%");
});
