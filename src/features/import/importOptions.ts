/** The import form: what to guess from the file, the mapping, the request, and progress. */
import type {
  ColumnMap,
  ImportFormat,
  ImportPreview,
  ImportRequest,
  ImportStatus,
  NewColumn,
} from "../../bindings.ts";

export type FormatKind = "csv" | "json";

export interface ImportForm {
  format: FormatKind;
  delimiter: string;
  header: boolean;
  nullText: string;
  /** Into a table that exists (`false`: a new one). */
  intoExisting: boolean;
  newTable: string;
  truncate: boolean;
  skipBadRows: boolean;
}

export const defaultImportForm: ImportForm = {
  format: "csv",
  delimiter: ",",
  header: true,
  nullText: "",
  intoExisting: true,
  newTable: "",
  truncate: false,
  skipBadRows: false,
};

export const DELIMITERS = [
  { value: ",", label: "Comma ( , )" },
  { value: ";", label: "Semicolon ( ; )" },
  { value: "\t", label: "Tab" },
  { value: "|", label: "Pipe ( | )" },
];

const extensionOf = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

/** The form's format settings a file's name suggests. */
export function guessFormat(path: string): Pick<ImportForm, "format" | "delimiter"> {
  switch (extensionOf(path)) {
    case "json":
    case "ndjson":
    case "jsonl":
      return { format: "json", delimiter: "," };
    case "tsv":
      return { format: "csv", delimiter: "\t" };
    default:
      return { format: "csv", delimiter: "," };
  }
}

/** `/Users/me/Orders 2026.csv` → `orders_2026`: a table name from the file's name. */
export function tableNameOf(path: string): string {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
  const name = stem
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (name === "") return "imported";
  return /^[0-9]/.test(name) ? `t_${name}` : name;
}

export function toFormat(form: ImportForm): ImportFormat {
  return form.format === "json"
    ? { kind: "json" }
    : {
        kind: "csv",
        delimiter: form.delimiter,
        quote: '"',
        header: form.header,
        nullText: form.nullText,
      };
}

/** Which table column each file column goes to: the one with the same name (any case), or none. */
export function autoMapping(
  fileColumns: string[],
  tableColumns: string[],
): Record<string, string | null> {
  const taken = new Set<string>();
  const result: Record<string, string | null> = {};
  for (const source of fileColumns) {
    const match = tableColumns.find(
      (c) => c.toLowerCase() === source.trim().toLowerCase() && !taken.has(c),
    );
    result[source] = match ?? null;
    if (match) taken.add(match);
  }
  return result;
}

/** The mapping as the backend wants it: skipped columns left out. */
export function mappingList(mapping: Record<string, string | null>): ColumnMap[] {
  return Object.entries(mapping).flatMap(([source, column]) =>
    column ? [{ source, column }] : [],
  );
}

/** What a table column is called when it is made from the file's: usable as a name. */
export function columnNameOf(source: string, taken: string[]): string {
  const base =
    source
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "column";
  const start = /^[0-9]/.test(base) ? `c_${base}` : base;
  let name = start;
  for (let n = 2; taken.includes(name); n++) name = `${start}_${n}`;
  return name;
}

/** The columns of a new table: a name and a type for each column of the file. */
export function newColumns(preview: ImportPreview): NewColumn[] {
  const taken: string[] = [];
  return preview.columns.map((source, i) => {
    const name = columnNameOf(source, taken);
    taken.push(name);
    return { source, name, typeName: preview.suggestedTypes[i] ?? "text" };
  });
}

/** What is wrong with the form, in words; `null` when the import can start. */
export function formProblem(form: ImportForm, mapped: number, columns: NewColumn[]): string | null {
  if (form.intoExisting) {
    return mapped === 0 ? "Map at least one column of the file to a column of the table." : null;
  }
  if (form.newTable.trim() === "") return "Give the new table a name.";
  if (columns.some((c) => c.name.trim() === "")) return "Every column needs a name.";
  const names = columns.map((c) => c.name.trim());
  if (new Set(names).size !== names.length) return "Two columns have the same name.";
  if (columns.some((c) => c.typeName.trim() === "")) return "Every column needs a type.";
  return null;
}

export function toRequest(
  path: string,
  form: ImportForm,
  schema: string,
  table: string,
  mapping: Record<string, string | null>,
  columns: NewColumn[],
): ImportRequest {
  return {
    path,
    format: toFormat(form),
    onError: form.skipBadRows ? "skip" : "abort",
    target: form.intoExisting
      ? { kind: "existing", schema, table, mapping: mappingList(mapping), truncate: form.truncate }
      : {
          kind: "new",
          schema,
          table: form.newTable.trim(),
          columns: columns.map((c) => ({ ...c, name: c.name.trim(), typeName: c.typeName.trim() })),
        },
  };
}

const number = new Intl.NumberFormat("en-US");

/** The fill of the progress bar (the share of the file read) and the line under it. */
export function progressOf(status: ImportStatus): { fraction: number; text: string } {
  const total = status.bytesTotal ?? 0;
  const read = status.bytesRead ?? 0;
  const fraction = status.state === "done" ? 1 : total > 0 ? Math.min(0.99, read / total) : 0;
  const rows = Math.round(status.rowsRead ?? 0);
  return { fraction, text: `${number.format(rows)} ${rows === 1 ? "row" : "rows"} read` };
}

/** The errors as text to copy: one per line. */
export function errorsText(status: ImportStatus): string {
  const lines = status.errors.map((e) => `${e.at}: ${e.message}`);
  if (status.moreErrors) lines.push("… and more");
  return lines.join("\n");
}
