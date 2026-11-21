/**
 * Reading `EXPLAIN (FORMAT JSON)` (ANG-35): a tree of nodes, with where the time (or, for a plain
 * EXPLAIN, the cost) went, the hottest node, and the things worth a warning.
 *
 * No alias imports: this runs under plain Node in the unit tests.
 */

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** How hot a node is, by its own share of the total: only the hottest is red. */
export type Heat = "none" | "warm" | "hot" | "hottest";

export interface PlanDetail {
  label: string;
  value: string;
}

export interface PlanNode {
  /** Position in the plan, depth first from 0 (the root). */
  id: number;
  depth: number;
  /** `Seq Scan`, `Hash Left Join`, `Partial Aggregate`, … as Postgres would write it in text. */
  name: string;
  /** What it works on: `public.users u`, `idx_orders_user`, … */
  target: string | null;
  startupCost: number;
  totalCost: number;
  planRows: number;
  planWidth: number;
  /** What really happened; `null` for a plain EXPLAIN. */
  actual: { rows: number; loops: number; startupMs: number; totalMs: number } | null;
  /** Time spent in this node and everything below it, over the whole run (all loops, workers merged). */
  wallMs: number | null;
  /** Time spent in this node alone. */
  exclusiveMs: number | null;
  /** Cost of this node alone (what the planner expected it to add). */
  exclusiveCost: number;
  /** Own share of the whole: time if analyzed, else cost. 0 to 1. */
  share: number;
  heat: Heat;
  /** The estimate and the real row count are far apart: `10` means 10× off, in either direction. */
  estimateOff: number | null;
  warnings: string[];
  details: PlanDetail[];
  relationship: string | null;
  /** `InitPlan 1`, `SubPlan 2`, `CTE x`. */
  subplanName: string | null;
  children: PlanNode[];
}

export interface ParsedPlan {
  root: PlanNode;
  /** Every node, depth first. */
  nodes: PlanNode[];
  analyzed: boolean;
  planningMs: number | null;
  executionMs: number | null;
  /** The node that spent the most itself; `null` when nothing stands out (all zero). */
  hottest: PlanNode | null;
  /** What the share of each node is a share of: execution time, or the root's cost. */
  basis: "time" | "cost";
  triggers: { name: string; ms: number | null; calls: number | null }[];
}

type Raw = Record<string, unknown>;

const isRaw = (value: unknown): value is Raw =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Rows or time above which a sequential scan is worth a warning. */
export const BIG_SCAN_ROWS = 100_000;
/** A plain EXPLAIN has no row counts for a scan: a high cost stands in. */
export const BIG_SCAN_COST = 10_000;
/** The estimate is off by this factor (either way) before it is mentioned. */
export const ESTIMATE_FACTOR = 10;

// ---- Naming ------------------------------------------------------------------------------------

/** `Hash Join` + `Left` → `Hash Left Join`; `Aggregate` + Hashed → `HashAggregate`; … */
function displayName(raw: Raw): string {
  let name = str(raw["Node Type"]) ?? "Node";
  // `ModifyTable` is how the JSON says "Insert on t", "Update on t", "Delete on t".
  const operation = str(raw["Operation"]);
  if (name === "ModifyTable" && operation) name = operation;
  const joinType = str(raw["Join Type"]);
  if (joinType && joinType !== "Inner" && /Join$/.test(name)) {
    name = name.replace(/Join$/, `${joinType} Join`);
  }
  if (name === "Aggregate") {
    const strategy = str(raw["Strategy"]);
    name =
      strategy === "Hashed"
        ? "HashAggregate"
        : strategy === "Sorted"
          ? "GroupAggregate"
          : strategy === "Mixed"
            ? "MixedAggregate"
            : "Aggregate";
    const mode = str(raw["Partial Mode"]);
    if (mode === "Partial" || mode === "Finalize") name = `${mode} ${name}`;
  }
  if (raw["Parallel Aware"] === true && /Scan$/.test(name) && !name.startsWith("Parallel")) {
    name = `Parallel ${name}`;
  }
  return name;
}

function targetOf(raw: Raw): string | null {
  const schema = str(raw["Schema"]);
  const relation = str(raw["Relation Name"]);
  const alias = str(raw["Alias"]);
  const index = str(raw["Index Name"]);
  const cte = str(raw["CTE Name"]);
  const fn = str(raw["Function Name"]);
  const base = relation ? (schema ? `${schema}.${relation}` : relation) : (cte ?? fn);
  const named = base && alias && alias !== relation && alias !== cte ? `${base} ${alias}` : base;
  if (index && named) return `${named} using ${index}`;
  return index ?? named;
}

// ---- Details -----------------------------------------------------------------------------------

/** What is worth showing under a node, in this order. */
const DETAIL_KEYS = [
  "Index Cond",
  "Recheck Cond",
  "Filter",
  "Rows Removed by Filter",
  "Rows Removed by Index Recheck",
  "Join Filter",
  "Rows Removed by Join Filter",
  "Hash Cond",
  "Merge Cond",
  "One-Time Filter",
  "Sort Key",
  "Presorted Key",
  "Sort Method",
  "Sort Space Used",
  "Sort Space Type",
  "Group Key",
  "Hash Buckets",
  "Hash Batches",
  "Peak Memory Usage",
  "Heap Fetches",
  "Exact Heap Blocks",
  "Lossy Heap Blocks",
  "Workers Planned",
  "Workers Launched",
  "Subplans Removed",
  "Conflict Resolution",
  "Conflict Arbiter Indexes",
  "Tuples Inserted",
  "Conflicting Tuples",
  "Output",
] as const;

/** For sentences: `95,000`. */
const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
/** For the plan text: `333303`, as Postgres writes it. */
const plainNumber = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
  useGrouping: false,
});

function detailValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return plainNumber.format(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map((v) => detailValue(v) ?? "").join(", ");
  return null;
}

function bufferLine(raw: Raw): string | null {
  const groups: [string, string][] = [
    ["shared", "Shared"],
    ["local", "Local"],
    ["temp", "Temp"],
  ];
  const parts: string[] = [];
  for (const [label, prefix] of groups) {
    const items: string[] = [];
    for (const [verb, key] of [
      ["hit", "Hit"],
      ["read", "Read"],
      ["dirtied", "Dirtied"],
      ["written", "Written"],
    ] as const) {
      const n = num(raw[`${prefix} ${key} Blocks`]);
      if (n) items.push(`${verb}=${n}`);
    }
    if (items.length) parts.push(`${label} ${items.join(" ")}`);
  }
  return parts.length ? parts.join(", ") : null;
}

// ---- Parsing -----------------------------------------------------------------------------------

function build(
  raw: Raw,
  depth: number,
  divisor: number,
  analyzed: boolean,
  nodes: PlanNode[],
): PlanNode {
  const id = nodes.length;
  const loops = num(raw["Actual Loops"]);
  const actual =
    analyzed && loops !== null && num(raw["Actual Total Time"]) !== null
      ? {
          rows: num(raw["Actual Rows"]) ?? 0,
          loops,
          startupMs: num(raw["Actual Startup Time"]) ?? 0,
          totalMs: num(raw["Actual Total Time"]) ?? 0,
        }
      : null;

  const details: PlanDetail[] = [];
  for (const key of DETAIL_KEYS) {
    const value = detailValue(raw[key]);
    if (value !== null && value !== "") details.push({ label: key, value });
  }
  const buffers = bufferLine(raw);
  if (buffers) details.push({ label: "Buffers", value: buffers });

  const node: PlanNode = {
    id,
    depth,
    name: displayName(raw),
    target: targetOf(raw),
    startupCost: num(raw["Startup Cost"]) ?? 0,
    totalCost: num(raw["Total Cost"]) ?? 0,
    planRows: num(raw["Plan Rows"]) ?? 0,
    planWidth: num(raw["Plan Width"]) ?? 0,
    actual,
    // All loops and workers in one number: a node under a Gather is counted per worker.
    wallMs: actual ? (actual.totalMs * actual.loops) / divisor : null,
    exclusiveMs: null,
    exclusiveCost: 0,
    share: 0,
    heat: "none",
    estimateOff: null,
    warnings: [],
    details,
    relationship: str(raw["Parent Relationship"]),
    subplanName: str(raw["Subplan Name"]),
    children: [],
  };
  nodes.push(node);

  // Below a Gather the leader and the workers each ran the node: count the work once.
  const launched = num(raw["Workers Launched"]);
  const childDivisor =
    launched !== null ? (raw["Single Copy"] === true ? 1 : launched + 1) * divisor : divisor;
  const plans = raw["Plans"];
  if (Array.isArray(plans)) {
    for (const child of plans) {
      if (isRaw(child)) node.children.push(build(child, depth + 1, childDivisor, analyzed, nodes));
    }
  }
  return node;
}

/** Fill in own time/cost, shares, heat and warnings once the whole tree is there. */
function annotate(plan: ParsedPlan) {
  const { root, nodes, analyzed } = plan;
  for (const node of nodes) {
    const childCost = node.children.reduce((sum, c) => sum + c.totalCost, 0);
    node.exclusiveCost = Math.max(0, node.totalCost - childCost);
    if (analyzed && node.wallMs !== null) {
      const childMs = node.children.reduce((sum, c) => sum + (c.wallMs ?? 0), 0);
      node.exclusiveMs = Math.max(0, node.wallMs - childMs);
    }
  }

  const useTime = analyzed && root.wallMs !== null;
  plan.basis = useTime ? "time" : "cost";
  const total = useTime
    ? Math.max(plan.executionMs ?? 0, root.wallMs ?? 0)
    : Math.max(root.totalCost, ...nodes.map((n) => n.totalCost));
  for (const node of nodes) {
    const own = useTime ? (node.exclusiveMs ?? 0) : node.exclusiveCost;
    node.share = total > 0 ? Math.min(1, own / total) : 0;
  }

  let hottest: PlanNode | null = null;
  for (const node of nodes) {
    if (node.share > (hottest?.share ?? 0)) hottest = node;
  }
  plan.hottest = hottest;
  for (const node of nodes) {
    node.heat =
      node === hottest
        ? "hottest"
        : node.share >= 0.25
          ? "hot"
          : node.share >= 0.1
            ? "warm"
            : "none";
  }

  for (const node of nodes) warn(node, analyzed);
}

function removedRows(node: PlanNode): number {
  const found = node.details.find((d) => d.label === "Rows Removed by Filter");
  return found ? Number(found.value.replace(/,/g, "")) || 0 : 0;
}

function warn(node: PlanNode, analyzed: boolean) {
  const fmt = (n: number) => numberFormat.format(Math.round(n));

  if (/Seq Scan$/.test(node.name)) {
    if (node.actual) {
      const scanned = (node.actual.rows + removedRows(node)) * node.actual.loops;
      if (scanned >= BIG_SCAN_ROWS) {
        node.warnings.push(
          `Sequential scan read about ${fmt(scanned)} rows. An index on the filtered column may help.`,
        );
      }
    } else if (!analyzed && node.totalCost >= BIG_SCAN_COST) {
      node.warnings.push(
        `Sequential scan with a high cost (${fmt(node.totalCost)}). An index may help.`,
      );
    }
  }

  if (node.actual) {
    const plan = Math.max(node.planRows, 1);
    const real = Math.max(node.actual.rows, 1);
    const factor = Math.max(real / plan, plan / real);
    if (factor >= ESTIMATE_FACTOR && Math.max(plan, real) >= 100) {
      node.estimateOff = Math.round(factor);
      node.warnings.push(
        `The planner expected ${fmt(node.planRows)} rows per loop but got ${fmt(node.actual.rows)}: run ANALYZE on the tables.`,
      );
    }
    const removed = removedRows(node);
    if (removed >= 10_000 && removed >= node.actual.rows * 10) {
      node.warnings.push(
        `The filter threw away ${fmt(removed)} rows to keep ${fmt(node.actual.rows)}.`,
      );
    }
  }

  const sortType = node.details.find((d) => d.label === "Sort Space Type")?.value;
  if (sortType === "Disk") node.warnings.push("The sort did not fit in memory and used disk.");
  const batches = Number(node.details.find((d) => d.label === "Hash Batches")?.value ?? 1);
  if (batches > 1)
    node.warnings.push(`The hash did not fit in memory: ${batches} batches on disk.`);
}

/** Read the single value `EXPLAIN (FORMAT JSON)` returns. Throws a {@link PlanError}. */
export function parsePlan(json: string): ParsedPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PlanError("The server's plan is not valid JSON.");
  }
  const top = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRaw(top) || !isRaw(top["Plan"])) throw new PlanError("This is not an EXPLAIN plan.");

  const executionMs = num(top["Execution Time"]);
  const analyzed = executionMs !== null || num((top["Plan"] as Raw)["Actual Total Time"]) !== null;
  const nodes: PlanNode[] = [];
  const root = build(top["Plan"], 0, 1, analyzed, nodes);

  const triggers = Array.isArray(top["Triggers"])
    ? top["Triggers"].filter(isRaw).map((t) => ({
        name: str(t["Trigger Name"]) ?? "trigger",
        ms: num(t["Time"]),
        calls: num(t["Calls"]),
      }))
    : [];

  const plan: ParsedPlan = {
    root,
    nodes,
    analyzed,
    planningMs: num(top["Planning Time"]),
    executionMs,
    hottest: null,
    basis: "cost",
    triggers,
  };
  annotate(plan);
  return plan;
}

// ---- Text --------------------------------------------------------------------------------------

const fixed = (n: number, digits: number) => n.toFixed(digits);

function header(node: PlanNode): string {
  const label = node.target ? `${node.name} on ${node.target}` : node.name;
  const costs = `(cost=${fixed(node.startupCost, 2)}..${fixed(node.totalCost, 2)} rows=${Math.round(node.planRows)} width=${node.planWidth})`;
  const actual = node.actual
    ? ` (actual time=${fixed(node.actual.startupMs, 3)}..${fixed(node.actual.totalMs, 3)} rows=${Math.round(node.actual.rows)} loops=${node.actual.loops})`
    : "";
  // `Index Scan using idx on t` reads better than `Index Scan on t using idx`.
  const readable = label.replace(/^(.*) on (.*) using (.*)$/, "$1 using $3 on $2");
  return `${readable}  ${costs}${actual}`;
}

/** The plan as indented text, laid out the way `EXPLAIN` prints it in its text format. */
export function planToText(plan: ParsedPlan): string {
  const lines: string[] = [];
  const spaces = (n: number) => " ".repeat(n);
  // `arrow` is the column of a child's `->`; null for the root, which has none. A node's details
  // start 6 columns after its arrow (2 for the root), and its children's arrows start there too.
  const walk = (node: PlanNode, arrow: number | null) => {
    lines.push(arrow === null ? header(node) : `${spaces(arrow)}->  ${header(node)}`);
    const details = arrow === null ? 2 : arrow + 6;
    for (const d of node.details) lines.push(`${spaces(details)}${d.label}: ${d.value}`);
    for (const child of node.children) {
      if (child.subplanName) {
        lines.push(`${spaces(details)}${child.subplanName}`);
        walk(child, details + 2);
      } else {
        walk(child, details);
      }
    }
  };
  walk(plan.root, null);
  if (plan.planningMs !== null) lines.push(`Planning Time: ${fixed(plan.planningMs, 3)} ms`);
  for (const t of plan.triggers) {
    lines.push(
      `Trigger ${t.name}: time=${t.ms === null ? "?" : fixed(t.ms, 3)} calls=${t.calls ?? "?"}`,
    );
  }
  if (plan.executionMs !== null) lines.push(`Execution Time: ${fixed(plan.executionMs, 3)} ms`);
  return lines.join("\n");
}

// ---- Words for the screen ----------------------------------------------------------------------

/** `0.012 ms`, `24.5 ms`, `1.4 s`: a time with enough digits to tell small ones apart. */
export function formatMs(ms: number): string {
  if (ms < 0.01) return "< 0.01 ms";
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 100) return `${ms.toFixed(1).replace(/\.0$/, "")} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2).replace(/\.?0+$/, "")} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** `42%`, or `< 1%` for something that is there but small. */
export function formatShare(share: number): string {
  if (share <= 0) return "0%";
  const percent = share * 100;
  return percent < 1 ? "< 1%" : `${Math.round(percent)}%`;
}
