/**
 * Fake row browsing for the in-browser mock backend. Rows are generated from the table's
 * columns (at most `MAX_ROWS` per table) and paged, sorted and filtered here the way the Rust
 * side does it in SQL. Values are text, like the real thing.
 */
import type {
  ColumnInfo,
  Filter,
  RowCount,
  RowPage,
  RowQuery,
  SortSpec,
  TableDescription,
} from "@/bindings";
import { mockDescribeTable, mockRowEstimate } from "@/dev/mockSchema";
import { appError, type Handler } from "@/dev/mockSupport";

const MAX_ROWS = 1000;
const MAX_LIMIT = 10_000;

type Row = (string | null)[];

const NUMERIC = ["smallint", "integer", "bigint", "numeric", "double precision", "real"];
const isNumeric = (column: ColumnInfo) => NUMERIC.includes(column.baseType);

function cell(column: ColumnInfo, i: number): string | null {
  // A bigint above 2^53: a JS number would round this, the text must not.
  if (column.name === "big_counter") return i === 1 ? "9007199254740993" : String(i * 1_000_003);
  if (!column.isPrimaryKey && column.nullable && i % 7 === 0) return null;
  switch (column.baseType) {
    case "bigint":
    case "integer":
    case "smallint":
      return String(i);
    case "numeric":
    case "double precision":
    case "real":
      return (i * 12.5).toFixed(2);
    case "boolean":
      return i % 2 === 0 ? "true" : "false";
    case "timestamp with time zone":
      return new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();
    case "jsonb":
    case "json":
      return `{"n": ${i}}`;
    case "text[]":
      return `{tag-${i % 3},tag-${i % 5}}`;
    case "user_status":
      return ["active", "invited", "suspended"][i % 3] ?? "active";
    default:
      return column.name === "email" ? `user${i}@example.com` : `${column.name}-${i}`;
  }
}

const cache = new Map<string, Row[]>();

function tableRows(desc: TableDescription): Row[] {
  const key = `${desc.schema}.${desc.name}`;
  let rows = cache.get(key);
  if (!rows) {
    const total = Math.min(mockRowEstimate(desc.schema, desc.name) ?? 50, MAX_ROWS);
    rows = Array.from({ length: total }, (_, n) => desc.columns.map((c) => cell(c, n + 1)));
    cache.set(key, rows);
  }
  return rows;
}

function column(desc: TableDescription, name: string): [index: number, column: ColumnInfo] {
  const index = desc.columns.findIndex((c) => c.name === name);
  const found = desc.columns[index];
  if (!found) throw appError("VALIDATION", `${desc.name} has no column "${name}"`);
  return [index, found];
}

function compare(c: ColumnInfo, a: string, b: string): number {
  return isNumeric(c) ? Number(a) - Number(b) : a.localeCompare(b);
}

function likeRegex(pattern: string, flags: string): RegExp {
  const body = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${body}$`, flags);
}

function matches(desc: TableDescription, row: Row, filter: Filter): boolean {
  const [index, c] = column(desc, filter.column);
  const value = row[index] ?? null;
  const [first = "", second = ""] = filter.values;
  switch (filter.op) {
    case "isNull":
      return value === null;
    case "isNotNull":
      return value !== null;
    case "like":
      return value !== null && likeRegex(first, "").test(value);
    case "iLike":
      return value !== null && likeRegex(first, "i").test(value);
    case "in":
      return value !== null && filter.values.some((v) => compare(c, value, v) === 0);
    case "between":
      return value !== null && compare(c, value, first) >= 0 && compare(c, value, second) <= 0;
    default: {
      if (value === null) return false; // NULL compared to anything is not true
      const order = compare(c, value, first);
      return {
        eq: order === 0,
        ne: order !== 0,
        lt: order < 0,
        gt: order > 0,
        le: order <= 0,
        ge: order >= 0,
      }[filter.op];
    }
  }
}

const RAW_COMPARISON = /^(\w+)\s*(=|<>|!=|<=|>=|<|>)\s*(?:'([^']*)'|(-?\d+(?:\.\d+)?))$/;
const RAW_OPS = {
  "=": "eq",
  "<>": "ne",
  "!=": "ne",
  "<=": "le",
  ">=": "ge",
  "<": "lt",
  ">": "gt",
} as const;

/**
 * Stands in for the server evaluating a raw WHERE: only `column <op> value` and `column IS [NOT]
 * NULL` are understood; anything else fails like a syntax error would.
 */
function rawFilter(raw: string): Filter {
  const text = raw
    .trim()
    .replace(/^where\s+/i, "")
    .replace(/;$/, "")
    .trim();
  const nulls = /^(\w+)\s+IS\s+(NOT\s+)?NULL$/i.exec(text);
  if (nulls?.[1]) return { column: nulls[1], op: nulls[2] ? "isNotNull" : "isNull", values: [] };
  const cmp = RAW_COMPARISON.exec(text);
  if (cmp?.[1] && cmp[2]) {
    const op = RAW_OPS[cmp[2] as keyof typeof RAW_OPS];
    return { column: cmp[1], op, values: [cmp[3] ?? cmp[4] ?? ""] };
  }
  throw appError("POSTGRES", `syntax error at or near "${text.split(/\s+/)[0] ?? ""}"`, {
    pgCode: "42601",
    hint: "The browser mock only understands `column = value` style conditions.",
  });
}

function filtered(desc: TableDescription, filters: Filter[], rawWhere: string | null): Row[] {
  const all = rawWhere && rawWhere.trim() ? [...filters, rawFilter(rawWhere)] : filters;
  return tableRows(desc).filter((row) => all.every((f) => matches(desc, row, f)));
}

function sorted(desc: TableDescription, rows: Row[], sort: SortSpec[]): Row[] {
  const keys = sort.map((s) => ({ ...s, at: column(desc, s.column) }));
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const {
      at: [index, c],
      dir,
    } of keys) {
      const x = a[index] ?? null;
      const y = b[index] ?? null;
      if (x === y) continue;
      // Postgres puts NULL last when ascending, first when descending.
      const order = x === null ? 1 : y === null ? -1 : compare(c, x, y);
      return dir === "asc" ? order : -order;
    }
    return 0;
  });
}

export function createRowHandlers(requireOpen: (id: string) => void): Record<string, Handler> {
  return {
    fetch_rows: (args): RowPage => {
      requireOpen(String(args["connectionId"]));
      const query = args["query"] as RowQuery;
      const desc = mockDescribeTable(query.schema, query.table);
      const limit = Math.min(Math.max(query.limit, 1), MAX_LIMIT);
      const all = sorted(desc, filtered(desc, query.filters, query.rawWhere), query.sort);
      const rows = all.slice(query.offset, query.offset + limit);
      return {
        columns: desc.columns.map((c) => ({
          name: c.name,
          typeOid: c.typeOid,
          typeName: c.typeName,
        })),
        rows,
        identity: desc.identity,
        ctids:
          desc.identity.kind === "ctid" ? rows.map((_, i) => `(0,${query.offset + i + 1})`) : [],
        hasMore: all.length > query.offset + limit,
      };
    },

    count_rows: (args): RowCount => {
      requireOpen(String(args["connectionId"]));
      const desc = mockDescribeTable(String(args["schema"]), String(args["table"]));
      const filters = args["filters"] as Filter[];
      const rawWhere = (args["rawWhere"] as string | null) ?? null;
      const estimate = mockRowEstimate(desc.schema, desc.name);
      if (
        filters.length === 0 &&
        !rawWhere &&
        args["exact"] !== true &&
        estimate !== null &&
        desc.kind === "table"
      ) {
        return { count: estimate, exact: false };
      }
      return { count: filtered(desc, filters, rawWhere).length, exact: true };
    },
  };
}
