/** The export form: what it asks, the request it becomes, and how progress reads. */
import type { ExportFormat, ExportStatus } from "../../bindings.ts";

export type FormatKind = "csv" | "json" | "sql" | "markdown";

export interface ExportForm {
  format: FormatKind;
  /** The actual character: `,` `;` a tab `|`. */
  delimiter: string;
  quote: string;
  header: boolean;
  nullText: string;
  /** JSON: one object per line instead of one array. */
  ndjson: boolean;
  /** SQL: rows per `INSERT`, as typed. */
  batchSize: string;
  /** SQL of a query: the table the `INSERT`s go into. */
  tableName: string;
}

export const defaultExportForm: ExportForm = {
  format: "csv",
  delimiter: ",",
  quote: '"',
  header: true,
  nullText: "",
  ndjson: false,
  batchSize: "100",
  tableName: "",
};

export const FORMATS: { value: FormatKind; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "sql", label: "SQL INSERT statements" },
  { value: "markdown", label: "Markdown table" },
];

export const DELIMITERS: { value: string; label: string }[] = [
  { value: ",", label: "Comma ( , )" },
  { value: ";", label: "Semicolon ( ; )" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe ( | )" },
];

export const QUOTES: { value: string; label: string }[] = [
  { value: '"', label: 'Double quote ( " )' },
  { value: "'", label: "Single quote ( ' )" },
];

const MAX_BATCH = 10_000;

/** The rows per `INSERT` as typed: a whole number from 1 up; anything else is the default. */
export function batchSizeOf(text: string): number {
  const n = Number(text.trim());
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_BATCH) : 100;
}

/** What is wrong with the form, in words; `null` when it can be sent. */
export function formProblem(form: ExportForm): string | null {
  if (form.format === "csv" && form.delimiter === form.quote) {
    return "The delimiter and the quote character must differ.";
  }
  if (form.format === "sql") {
    const text = form.batchSize.trim();
    const n = Number(text);
    if (text === "" || !Number.isInteger(n) || n < 1) return "Rows per INSERT is a whole number.";
  }
  return null;
}

export function toFormat(form: ExportForm): ExportFormat {
  switch (form.format) {
    case "csv":
      return {
        kind: "csv",
        delimiter: form.delimiter,
        quote: form.quote,
        header: form.header,
        nullText: form.nullText,
      };
    case "json":
      return { kind: "json", ndjson: form.ndjson };
    case "sql":
      return { kind: "sql", batchSize: batchSizeOf(form.batchSize) };
    case "markdown":
      return { kind: "markdown" };
  }
}

export function extensionOf(form: ExportForm): string {
  switch (form.format) {
    case "csv":
      return form.delimiter === "\t" ? "tsv" : "csv";
    case "json":
      return form.ndjson ? "ndjson" : "json";
    case "sql":
      return "sql";
    case "markdown":
      return "md";
  }
}

/** `users.csv`: a name for the save dialog. Nothing a file system dislikes in it. */
export function defaultFileName(base: string, form: ExportForm): string {
  const clean = base.replace(/[/\\:\0]/g, "_").trim() || "export";
  return `${clean}.${extensionOf(form)}`;
}

const number = new Intl.NumberFormat("en-US");

function size(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The progress bar's fill (`null`: unknown, show it as busy) and the line of text under it. */
export function progressOf(status: ExportStatus): { fraction: number | null; text: string } {
  const written = status.rows ?? 0;
  const rows = Math.round(written);
  const text = `${number.format(rows)} ${rows === 1 ? "row" : "rows"} · ${size(status.bytes ?? 0)}`;
  if (status.state === "done") return { fraction: 1, text };
  const guess = status.estimatedRows;
  if (status.state !== "running" || !guess || guess <= 0) return { fraction: null, text };
  // An estimate can be off either way: never say it is finished before it is.
  return { fraction: Math.min(0.99, written / guess), text };
}

/** The folder part of a path, for "Show in Finder" of a file that is not there. */
export function folderOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : path;
}
