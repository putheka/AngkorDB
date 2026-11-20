/**
 * Fake `preview_changes` and `apply_changes` for the in-browser mock backend. They follow the
 * Rust rules: deletes, then updates, then inserts; each update and delete must hit exactly one
 * row; everything is committed or nothing is. Typing the value `FAIL` into a cell makes that
 * change fail like a too-long `varchar(3)` would, so the error path can be tried by hand.
 */
import type {
  ApplyResult,
  CellValue,
  RowRef,
  SafeMode,
  TableChanges,
  TableDescription,
} from "@/bindings";
import { column, setTableRows, tableRows, type Row } from "@/dev/mockRows";
import { mockDescribeTable } from "@/dev/mockSchema";
import { appError, sleep, type Handler } from "@/dev/mockSupport";

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const cellSql = (value: CellValue) =>
  value.kind === "default" ? "DEFAULT" : value.kind === "null" ? "NULL" : literal(value.text);

function whereSql(ref: RowRef): { sql: string; name: string } {
  if (ref.kind === "ctid") return { sql: `ctid = ${literal(ref.ctid)}`, name: `ctid ${ref.ctid}` };
  return {
    sql: ref.columns.map((c, i) => `${quote(c)} = ${literal(ref.values[i] ?? "")}`).join(" AND "),
    name: ref.columns.map((c, i) => `${c} = ${ref.values[i] ?? ""}`).join(", "),
  };
}

interface Step {
  kind: "delete" | "update" | "insert";
  label: string;
  sql: string;
  run: (rows: Row[]) => Row[];
  /** What the step produced, for an insert. */
  inserted?: Row;
}

function locate(desc: TableDescription, rows: Row[], ref: RowRef): number {
  if (ref.kind === "ctid") return Number(/\d+/.exec(ref.ctid.split(",")[1] ?? "")?.[0] ?? 0) - 1;
  const at = ref.columns.map((name) => column(desc, name)[0]);
  return rows.findIndex((row) => at.every((index, i) => row[index] === ref.values[i]));
}

/** The statements of a change set, in the order they run. */
function build(desc: TableDescription, changes: TableChanges): Step[] {
  if (desc.identity.kind === "readOnly") throw appError("VALIDATION", desc.identity.reason);
  const table = `${quote(desc.schema)}.${quote(desc.name)}`;
  const steps: Step[] = [];
  const names = (values: Record<string, CellValue>) =>
    Object.keys(values).sort((a, b) => column(desc, a)[0] - column(desc, b)[0]);

  for (const ref of changes.deletes) {
    const where = whereSql(ref);
    steps.push({
      kind: "delete",
      label: `delete row ${where.name}`,
      sql: `DELETE FROM ${table} WHERE ${where.sql}`,
      run: (rows) => {
        const at = locate(desc, rows, ref);
        if (at < 0) throw new Error("row changed or missing");
        return rows.filter((_, i) => i !== at);
      },
    });
  }

  for (const { row: ref, values } of changes.updates) {
    const where = whereSql(ref);
    const set = names(values).map((n) => `${quote(n)} = ${cellSql(values[n] as CellValue)}`);
    steps.push({
      kind: "update",
      label: `update row ${where.name}`,
      sql: `UPDATE ${table} SET ${set.join(", ")} WHERE ${where.sql}`,
      run: (rows) => {
        const at = locate(desc, rows, ref);
        const found = rows[at];
        if (!found) throw new Error("row changed or missing");
        const next = [...found];
        for (const [name, value] of Object.entries(values)) {
          if (value.kind === "value" && value.text === "FAIL") {
            throw new Error("value too long for type character varying(3)");
          }
          next[column(desc, name)[0]] = value.kind === "value" ? value.text : null;
        }
        return rows.map((r, i) => (i === at ? next : r));
      },
    });
  }

  changes.inserts.forEach(({ values }, n) => {
    const given = names(values);
    steps.push({
      kind: "insert",
      label: `insert new row ${n + 1}`,
      sql:
        given.length === 0
          ? `INSERT INTO ${table} DEFAULT VALUES`
          : `INSERT INTO ${table} (${given.map(quote).join(", ")}) VALUES (${given
              .map((g) => cellSql(values[g] as CellValue))
              .join(", ")})`,
      run: (rows) => {
        const serial = Math.max(0, ...rows.map((r) => Number(r[0]) || 0)) + 1;
        const row: Row = desc.columns.map((c, i) => {
          const value = values[c.name];
          if (value?.kind === "value") {
            if (value.text === "FAIL") {
              throw new Error("value too long for type character varying(3)");
            }
            return value.text;
          }
          return i === 0 && desc.identity.kind === "primaryKey" ? String(serial) : null;
        });
        return [...rows, row];
      },
    });
  });
  return steps;
}

export function createChangeHandlers(
  requireOpen: (id: string) => void,
  safeModeOf: (id: string) => SafeMode | undefined,
): Record<string, Handler> {
  return {
    preview_changes: (args): string => {
      requireOpen(String(args["connectionId"]));
      const desc = mockDescribeTable(String(args["schema"]), String(args["table"]));
      const steps = build(desc, args["changes"] as TableChanges);
      if (steps.length === 0) return "";
      return ["BEGIN;", ...steps.map((s) => `${s.sql};`), "COMMIT;"].join("\n");
    },

    apply_changes: async (args): Promise<ApplyResult> => {
      const id = String(args["connectionId"]);
      requireOpen(id);
      if (safeModeOf(id) === "read-only") {
        throw appError("VALIDATION", "This connection is read-only (safe mode).");
      }
      const desc = mockDescribeTable(String(args["schema"]), String(args["table"]));
      const steps = build(desc, args["changes"] as TableChanges);
      await sleep(250);

      // Work on a copy: a failing step leaves the table as it was.
      let rows = tableRows(desc).map((r) => [...r]);
      const result: ApplyResult = { updated: 0, deleted: 0, inserted: [] };
      for (const [i, step] of steps.entries()) {
        try {
          rows = step.run(rows);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw appError(
            "CHANGE_FAILED",
            `Change ${i + 1} of ${steps.length} (${step.label}) failed: ${reason} — nothing was saved.`,
            reason.startsWith("value too long") ? { pgCode: "22001" } : {},
          );
        }
        if (step.kind === "update") result.updated++;
        else if (step.kind === "delete") result.deleted++;
        else result.inserted.push([...(rows[rows.length - 1] ?? [])]);
      }
      setTableRows(desc, rows);
      return result;
    },
  };
}
