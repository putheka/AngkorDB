/**
 * Rows as text for the clipboard (ANG-28): TSV, CSV, JSON, Markdown, and the SQL that would
 * insert or update them. Pure functions, no imports from the app, so they run under Node tests.
 */
import type { CellValue } from "../editing/changes.ts";
import type { EditorKind } from "../editing/editorKind.ts";
import { parseJson, stringifyJson } from "../../../lib/json.ts";

export type CopyFormat = "tsv" | "csv" | "json" | "markdown" | "insert" | "update";

export const COPY_FORMATS: { format: CopyFormat; label: string }[] = [
  { format: "tsv", label: "TSV (tab-separated)" },
  { format: "csv", label: "CSV" },
  { format: "json", label: "JSON" },
  { format: "markdown", label: "Markdown table" },
  { format: "insert", label: "INSERT statements" },
  { format: "update", label: "UPDATE statements" },
];

export interface CopyColumn {
  name: string;
  kind: EditorKind;
}

/** What identifies one row, for `UPDATE … WHERE`. */
export interface RowKey {
  column: string;
  kind: EditorKind;
  value: string;
}

export interface CopyRow {
  cells: CellValue[];
  /** `null` for a row that is not in the table yet (a new row) or a table without a usable key. */
  key: RowKey[] | null;
}

export interface CopyTable {
  schema: string;
  name: string;
}

const text = (cell: CellValue): string | null => (cell.kind === "value" ? cell.text : null);

/** `"name"` with a `"` inside doubled. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const isNumeric = (kind: EditorKind) => kind === "integer" || kind === "decimal";

/** A value as SQL: numbers and booleans bare, everything else a quoted string the server casts. */
export function sqlLiteral(cell: CellValue, kind: EditorKind): string {
  if (cell.kind === "null") return "NULL";
  if (cell.kind === "default") return "DEFAULT";
  const value = cell.text;
  if (isNumeric(kind) && NUMBER.test(value)) return value;
  if (kind === "bool" && (value === "true" || value === "false")) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

/** TSV fields with a tab, line break or quote in them are quoted, which Excel and Sheets read back. */
function tsvField(value: string | null): string {
  if (value === null) return "";
  return /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * CSV the way `COPY … CSV` writes it: NULL is an empty field with nothing in it, an empty string
 * is `""`, so a value that is NULL and one that is empty come back as what they were.
 */
function csvField(value: string | null): string {
  if (value === null) return "";
  if (value === "") return '""';
  return /[,"\r\n]/.test(value) || value !== value.trim()
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

function jsonValue(cell: CellValue, kind: EditorKind): string {
  const value = text(cell);
  if (value === null) return "null";
  if (isNumeric(kind) && JSON_NUMBER.test(value)) return value; // exact, never through a JS number
  if (kind === "bool" && (value === "true" || value === "false")) return value;
  if (kind === "json") {
    try {
      return stringifyJson(parseJson(value));
    } catch {
      // not valid JSON (it should be): keep it as the string it is
    }
  }
  return JSON.stringify(value);
}

const markdownCell = (value: string | null) =>
  value === null ? "NULL" : value.replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");

/** What `format` makes of the rows. UPDATE skips rows it can't address and says how many. */
export function formatRows(
  format: CopyFormat,
  columns: readonly CopyColumn[],
  rows: readonly CopyRow[],
  table: CopyTable,
): { text: string; skipped: number } {
  const names = columns.map((c) => c.name);
  const lines: string[] = [];
  let skipped = 0;

  switch (format) {
    case "tsv":
      for (const row of rows) lines.push(row.cells.map((c) => tsvField(text(c))).join("\t"));
      break;
    case "csv":
      lines.push(names.map((n) => csvField(n)).join(","));
      for (const row of rows) lines.push(row.cells.map((c) => csvField(text(c))).join(","));
      break;
    case "json": {
      const objects = rows.map((row) => {
        const fields = columns.map(
          (c, i) =>
            `${JSON.stringify(c.name)}: ${jsonValue(row.cells[i] ?? { kind: "null" }, c.kind)}`,
        );
        return `  {${fields.join(", ")}}`;
      });
      return { text: objects.length === 0 ? "[]" : `[\n${objects.join(",\n")}\n]`, skipped };
    }
    case "markdown":
      lines.push(`| ${names.map(markdownCell).join(" | ")} |`);
      lines.push(`| ${names.map(() => "---").join(" | ")} |`);
      for (const row of rows)
        lines.push(`| ${row.cells.map((c) => markdownCell(text(c))).join(" | ")} |`);
      break;
    case "insert": {
      const target = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
      const list = names.map(quoteIdent).join(", ");
      for (const row of rows) {
        const values = columns.map((c, i) => sqlLiteral(row.cells[i] ?? { kind: "null" }, c.kind));
        lines.push(`INSERT INTO ${target} (${list}) VALUES (${values.join(", ")});`);
      }
      break;
    }
    case "update": {
      const target = `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
      for (const row of rows) {
        const key = row.key;
        const keyNames = new Set(key?.map((k) => k.column));
        const assignments = columns
          .map((c, i) => ({ c, cell: row.cells[i] ?? ({ kind: "null" } as CellValue) }))
          .filter(({ c }) => !keyNames.has(c.name))
          .map(({ c, cell }) => `${quoteIdent(c.name)} = ${sqlLiteral(cell, c.kind)}`);
        if (!key || key.length === 0 || assignments.length === 0) {
          skipped++;
          continue;
        }
        const where = key
          .map(
            (k) =>
              `${quoteIdent(k.column)} = ${sqlLiteral({ kind: "value", text: k.value }, k.kind)}`,
          )
          .join(" AND ");
        lines.push(`UPDATE ${target} SET ${assignments.join(", ")} WHERE ${where};`);
      }
      break;
    }
  }
  return { text: lines.join("\n"), skipped };
}
