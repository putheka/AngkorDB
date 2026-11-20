/**
 * Rows from clipboard text (ANG-28): TSV as Excel and Sheets copy it, or CSV, mapped onto the
 * columns of a table. Pure functions, no imports from the app, so they run under Node tests.
 */
import type { CellValue } from "../editing/changes.ts";
import { normalize, validate, type EditorKind } from "../editing/editorKind.ts";

export interface ParsedField {
  text: string;
  /** It was written in quotes, so an empty one is an empty string, not "nothing". */
  quoted: boolean;
}

/**
 * Tab (Excel, Sheets) or comma (CSV), from the first row alone and outside quotes, so a tab or
 * comma inside a value doesn't decide it. A single column has neither: tab.
 */
export function detectDelimiter(text: string): "\t" | "," {
  let tabs = 0;
  let commas = 0;
  let inQuotes = false;
  for (const c of text) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === "\n" || c === "\r")) break;
    else if (!inQuotes && c === "\t") tabs++;
    else if (!inQuotes && c === ",") commas++;
  }
  return tabs > 0 || commas === 0 ? "\t" : ",";
}

/**
 * Split text into rows of fields, RFC 4180 style: a field may be in quotes, a doubled quote
 * inside is one quote, and tabs, commas and line breaks in quotes are part of the value. Blank
 * lines are dropped.
 */
export function parseDelimited(source: string, delimiter: "\t" | ","): ParsedField[][] {
  const rows: ParsedField[][] = [];
  let row: ParsedField[] = [];
  let value = "";
  let quoted = false;
  let inQuotes = false;
  let touched = false; // something was read into the current field or row

  const endField = () => {
    row.push({ text: value, quoted });
    value = "";
    quoted = false;
    touched = true;
  };
  const endRow = () => {
    // A line with nothing on it is not a row of one empty field.
    if (touched || row.length > 0) {
      endField();
      const blank = row.length === 1 && !row[0]?.quoted && row[0]?.text.trim() === "";
      if (!blank) rows.push(row);
    }
    row = [];
    touched = false;
  };

  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (source.charAt(i + 1) === '"') {
          value += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        value += c;
      }
    } else if (c === '"' && value === "" && !quoted) {
      inQuotes = true;
      quoted = true;
      touched = true;
    } else if (c === delimiter) {
      endField();
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && source.charAt(i + 1) === "\n") i++;
      endRow();
    } else {
      value += c;
      touched = true;
    }
  }
  endRow();
  return rows;
}

export interface PasteColumn {
  name: string;
  kind: EditorKind;
  typeOid: number;
  /** Generated, or `GENERATED ALWAYS AS IDENTITY`: the server refuses a value. */
  writable: boolean;
  /** It has a default, or an identity: an empty cell means "use it". */
  hasDefault: boolean;
}

export type PasteResult =
  | {
      ok: true;
      rows: Record<string, CellValue>[];
      /** The pasted rows came with a header, and the columns were matched by name. */
      usedHeader: boolean;
      /** Columns whose pasted values were not used, because the server makes them. */
      skipped: string[];
      /** Fields beyond the last column, which were left out. */
      ignoredFields: number;
    }
  | { ok: false; error: string };

export const MAX_PASTE_ROWS = 10_000;

/**
 * New rows from clipboard text. `columns` are the table's columns in the order the pasted
 * fields are in (what is on screen): field 1 goes to column 1, and so on. If the first row is
 * the names of columns, it is a header: the rest is matched by name instead.
 */
export function rowsFromText(source: string, columns: readonly PasteColumn[]): PasteResult {
  const parsed = parseDelimited(source, detectDelimiter(source));
  if (parsed.length === 0) return { ok: false, error: "The clipboard has no rows to paste." };

  // A header: every field of the first row names a different column.
  let targets: (PasteColumn | undefined)[] = columns.slice();
  let body = parsed;
  let usedHeader = false;
  const first = parsed[0] ?? [];
  const byName = first.map((f) =>
    columns.find((c) => c.name.toLowerCase() === f.text.trim().toLowerCase()),
  );
  if (
    first.length > 0 &&
    byName.every((c) => c !== undefined) &&
    new Set(byName.map((c) => c?.name)).size === byName.length
  ) {
    targets = byName;
    body = parsed.slice(1);
    usedHeader = true;
  }
  if (body.length === 0) return { ok: false, error: "There are only column names, no rows." };
  if (body.length > MAX_PASTE_ROWS) {
    return {
      ok: false,
      error: `That is ${body.length.toLocaleString("en-US")} rows; paste at most ${MAX_PASTE_ROWS.toLocaleString("en-US")} at a time.`,
    };
  }

  const skipped = new Set<string>();
  let ignoredFields = 0;
  const rows: Record<string, CellValue>[] = [];

  for (const [rowIndex, fields] of body.entries()) {
    const values: Record<string, CellValue> = {};
    ignoredFields += Math.max(0, fields.length - targets.length);
    for (const [i, column] of targets.entries()) {
      const field = fields[i];
      if (!column || !field) continue; // fewer fields than columns: the rest stay DEFAULT
      if (!column.writable) {
        if (field.text !== "") skipped.add(column.name);
        continue;
      }
      if (field.text === "" && !field.quoted) {
        // Nothing in the cell: the column's own default if it has one, else NULL.
        values[column.name] = column.hasDefault ? { kind: "default" } : { kind: "null" };
        continue;
      }
      if (field.text === "" && column.kind !== "text" && column.kind !== "userType") {
        // `""` in a number or date column is not a value.
        values[column.name] = { kind: "null" };
        continue;
      }
      const problem = field.text === "" ? null : validate(column.kind, column.typeOid, field.text);
      if (problem) {
        return {
          ok: false,
          error: `Row ${rowIndex + 1}, ${column.name}: ${problem}`,
        };
      }
      values[column.name] = { kind: "value", text: normalize(column.kind, field.text) };
    }
    rows.push(values);
  }
  return { ok: true, rows, usedHeader, skipped: [...skipped], ignoredFields };
}
