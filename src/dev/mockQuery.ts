/**
 * Fake SQL tab for the in-browser mock backend. It splits the text into statements the way the
 * Rust side does, then pretends to run each: `SELECT 1`, `SELECT * FROM users LIMIT 5`,
 * `SELECT g FROM generate_series(1, 25000) g`, `SELECT pg_sleep(5)`, INSERT/UPDATE/DELETE and
 * DDL give plausible results; anything else is a syntax error at its first word.
 */
import type {
  ExplainRun,
  QueryRun,
  StatementClass,
  StatementOutcome,
  StatementResult,
  TextRange,
} from "@/bindings";
import { recordHistory } from "@/dev/mockHistory";
import { BIG_SCAN_PLAN, JOIN_PLAN, UPDATE_PLAN, planWithoutActuals } from "@/dev/planFixtures";
import { mockTableData } from "@/dev/mockRows";
import { appError, sleep, type Handler } from "@/dev/mockSupport";

const MAX_ROWS = 10_000;

interface Span {
  start: number;
  end: number;
  /** One past the `;`. */
  terminatedEnd: number;
}

/** Statements of `sql`: `;` ends one unless inside quotes, a dollar-quoted body or a comment. */
export function splitStatements(sql: string): Span[] {
  const spans: Span[] = [];
  let start = -1;
  let lastEnd = 0;
  let hasCode = false;
  const finish = (terminatedEnd: number) => {
    if (start >= 0 && hasCode) spans.push({ start, end: lastEnd, terminatedEnd });
    start = -1;
    hasCode = false;
  };

  let i = 0;
  while (i < sql.length) {
    const c = sql.charAt(i);
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === ";") {
      finish(i + 1);
      i++;
      continue;
    }

    let end = i + 1;
    let code = true;
    if (c === "-" && sql.charAt(i + 1) === "-") {
      const newline = sql.indexOf("\n", i);
      end = newline < 0 ? sql.length : newline;
      code = false;
    } else if (c === "/" && sql.charAt(i + 1) === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      end = j;
      code = false;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql.charAt(j) === c) {
          if (sql.charAt(j + 1) === c) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      end = j;
    } else if (c === "$" && !/\w/.test(sql.charAt(i - 1))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        end = close < 0 ? sql.length : close + tag.length;
      }
    }
    if (start < 0) start = i;
    lastEnd = end;
    hasCode ||= code;
    i = end;
  }
  finish(lastEnd);
  return spans;
}

/** The statement the cursor is in: the one it touches, else the one above, else the first. */
export function statementAt(sql: string, cursor: number): TextRange | null {
  const spans = splitStatements(sql);
  let previous: Span | undefined;
  let found: Span | undefined;
  for (const span of spans) {
    if (cursor < span.start) {
      found = previous ?? span;
      break;
    }
    if (cursor <= span.terminatedEnd) {
      found = span;
      break;
    }
    previous = span;
  }
  found ??= previous;
  return found ? { start: found.start, end: found.end } : null;
}

const cancelled = new Set<string>();
const knownTabs = new Set<string>();

const syntaxError = (word: string, offset: number): StatementOutcome => ({
  kind: "error",
  error: appError("POSTGRES", `syntax error at or near "${word}"`, {
    pgCode: "42601",
    position: offset + 1,
  }),
  offset,
});

/** Pretend to run one statement. `at` is where it starts in the whole text. */
async function execute(tabId: string, text: string, at: number): Promise<StatementOutcome> {
  const body = text.replace(/^(\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, "");
  const skipped = text.length - body.length;
  const word = /^[A-Za-z]+/.exec(body)?.[0] ?? body.split(/\s+/)[0] ?? "";
  const command = word.toUpperCase();

  if (["SELECT", "WITH", "VALUES", "TABLE", "SHOW"].includes(command)) {
    const sleepFor = /pg_sleep\(\s*(\d+(?:\.\d+)?)\s*\)/i.exec(body);
    if (sleepFor?.[1]) {
      const until = Date.now() + Number(sleepFor[1]) * 1000;
      while (Date.now() < until) {
        if (cancelled.delete(tabId)) {
          return {
            kind: "error",
            error: appError("POSTGRES", "canceling statement due to user request", {
              pgCode: "57014",
            }),
            offset: null,
          };
        }
        await sleep(50);
      }
      return rowsOf([{ name: "pg_sleep", typeOid: 2278 }], [[""]]);
    }

    const series = /^select\s+(\w+)\s+from\s+generate_series\(\s*1\s*,\s*(\d+)\s*\)/i.exec(body);
    if (series?.[1] && series[2]) {
      const total = Number(series[2]);
      const count = Math.min(total, MAX_ROWS);
      return rowsOf(
        [{ name: series[1], typeOid: 23 }],
        Array.from({ length: count }, (_, i) => [String(i + 1)]),
        total > MAX_ROWS,
      );
    }

    const table = /^select\s+\*\s+from\s+(?:(\w+)\.)?(\w+)(?:\s+limit\s+(\d+))?$/i.exec(body);
    if (table?.[2]) {
      try {
        const data = mockTableData(table[1] ?? "public", table[2], Number(table[3] ?? MAX_ROWS));
        return { kind: "rows", columns: data.columns, rows: data.rows, truncated: false };
      } catch {
        const nameAt = at + skipped + body.search(new RegExp(`\\b${table[2]}\\b`, "i"));
        return {
          kind: "error",
          error: appError("POSTGRES", `relation "${table[2]}" does not exist`, {
            pgCode: "42P01",
            position: nameAt - at + 1,
          }),
          offset: nameAt,
        };
      }
    }

    if (command === "SHOW") {
      return rowsOf([{ name: body.split(/\s+/)[1] ?? "setting", typeOid: 25 }], [["mock"]]);
    }
    // Any other SELECT: one row with the expression itself.
    const expression = body.replace(/^select\s+/i, "").replace(/\s+as\s+\w+$/i, "");
    return rowsOf([{ name: "?column?", typeOid: 25 }], [[expression]]);
  }

  if (command === "INSERT") return { kind: "command", command, affected: 1 };
  if (command === "UPDATE" || command === "DELETE")
    return { kind: "command", command, affected: 3 };
  if (
    [
      "CREATE",
      "ALTER",
      "DROP",
      "TRUNCATE",
      "BEGIN",
      "COMMIT",
      "ROLLBACK",
      "SET",
      "GRANT",
      "COMMENT",
      "DO",
      "VACUUM",
      "ANALYZE",
    ].includes(command)
  ) {
    return { kind: "command", command, affected: 0 };
  }
  return syntaxError(word, at + skipped);
}

function rowsOf(
  columns: { name: string; typeOid: number }[],
  rows: (string | null)[][],
  truncated = false,
): StatementOutcome {
  return {
    kind: "rows",
    columns: columns.map((c) => ({ ...c, typeName: c.typeOid === 23 ? "int4" : "text" })),
    rows,
    truncated,
  };
}

const WRITES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "MERGE", "CALL", "DO", "REFRESH"];
const SCHEMA_CHANGES = ["CREATE", "ALTER", "DROP", "GRANT", "REVOKE", "COMMENT", "VACUUM"];

/** The first word decides; the real classifier (Rust) looks deeper, e.g. into CTEs. */
function classifyStatement(sql: string, span: Span): StatementClass {
  const text = sql.slice(span.start, span.end);
  const command = (
    /^(?:\s|--[^\n]*\n?|\/\*[\s\S]*?\*\/)*([A-Za-z]+)/.exec(text)?.[1] ?? ""
  ).toUpperCase();
  const kind = WRITES.includes(command)
    ? "write"
    : SCHEMA_CHANGES.includes(command)
      ? "schema"
      : "read";
  return {
    range: { start: span.start, end: span.end },
    kind,
    command,
    unlocksWrites: /default_transaction_read_only|read\s+write/i.test(text),
  };
}

export function createQueryHandlers(requireOpen: (id: string) => void): Record<string, Handler> {
  return {
    run_query: async (args): Promise<QueryRun> => {
      requireOpen(String(args["connectionId"]));
      const tabId = String(args["tabId"]);
      const sql = String(args["sql"]);
      knownTabs.add(tabId);
      cancelled.delete(tabId);

      const started = Date.now();
      const statements: StatementResult[] = [];
      for (const span of splitStatements(sql)) {
        const t0 = Date.now();
        await sleep(30); // a little latency, so the running state is visible
        const outcome = await execute(tabId, sql.slice(span.start, span.end), span.start);
        recordHistory(
          String(args["connectionId"]),
          sql.slice(span.start, span.end),
          Date.now() - t0,
          outcome.kind !== "error",
        );
        statements.push({
          range: { start: span.start, end: span.end },
          durationMs: Date.now() - t0,
          outcome,
          notices:
            outcome.kind === "command" && outcome.command === "DO"
              ? [
                  {
                    severity: "NOTICE",
                    message: "hello from DO",
                    detail: null,
                    hint: null,
                    code: "00000",
                  },
                ]
              : [],
        });
        if (outcome.kind === "error") break;
      }
      return { statements, durationMs: Date.now() - started };
    },

    explain_query: async (args): Promise<ExplainRun> => {
      requireOpen(String(args["connectionId"]));
      const sql = String(args["sql"]);
      const analyze = args["analyze"] === true;
      const spans = splitStatements(sql);
      const span = spans[0];
      if (!span) {
        throw appError(
          "VALIDATION",
          "There is no SQL to explain: the editor is empty or only has comments.",
        );
      }
      if (spans.length > 1) {
        throw appError(
          "VALIDATION",
          "Explain works on one statement at a time. Put the cursor in the statement, or select it.",
        );
      }
      const text = sql.slice(span.start, span.end);
      const kind = classifyStatement(sql, span);
      if (/^\s*explain\b/i.test(text)) {
        throw appError(
          "VALIDATION",
          "This statement already starts with EXPLAIN. Remove it: the Explain buttons add it.",
        );
      }
      await sleep(analyze ? 120 : 40);

      const missing = /no_such_table/i.exec(text);
      if (missing) {
        return {
          outcome: {
            kind: "error",
            error: appError("POSTGRES", 'relation "no_such_table" does not exist', {
              pgCode: "42P01",
              position: missing.index + 1,
            }),
            offset: span.start + missing.index,
          },
          durationMs: 3,
          analyzed: analyze,
          statementKind: kind.kind,
          command: kind.command,
          rolledBack: analyze,
        };
      }

      const plan = /metrics_big/i.test(text)
        ? BIG_SCAN_PLAN
        : kind.kind !== "read"
          ? UPDATE_PLAN
          : JOIN_PLAN;
      return {
        outcome: {
          kind: "plan",
          json: JSON.stringify(analyze ? plan : planWithoutActuals(plan)),
        },
        durationMs: analyze ? 24 : 2,
        analyzed: analyze,
        statementKind: kind.kind,
        command: kind.command,
        rolledBack: analyze,
      };
    },

    cancel_query: (args) => {
      requireOpen(String(args["connectionId"]));
      const tabId = String(args["tabId"]);
      if (!knownTabs.has(tabId)) return false;
      cancelled.add(tabId);
      return true;
    },

    close_query_tab: (args) => {
      knownTabs.delete(String(args["tabId"]));
      return null;
    },

    statement_at: (args) => statementAt(String(args["sql"]), Number(args["cursor"])),

    classify_sql: (args): StatementClass[] => {
      const sql = String(args["sql"]);
      return splitStatements(sql).map((span) => classifyStatement(sql, span));
    },

    // The real one shows the macOS Touch ID sheet; here the answer comes after a moment.
    authenticate_user: async () => {
      await sleep(500);
      return null;
    },
  };
}
