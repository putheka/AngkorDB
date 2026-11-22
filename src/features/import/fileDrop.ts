/** What dropping files on the window does (pure, so it can be tested). */

/** The extensions the import dialog reads. */
const IMPORTABLE = ["csv", "tsv", "txt", "json", "ndjson", "jsonl"];

export function isImportable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  // `.csv` alone is a hidden file with no extension.
  return dot > path.lastIndexOf("/") + 1 && IMPORTABLE.includes(path.slice(dot + 1).toLowerCase());
}

/** The file to import out of what was dropped: the first one that can be, and how many were left. */
export function chooseDropped(paths: readonly string[]): { path: string | null; left: number } {
  const path = paths.find(isImportable) ?? null;
  return { path, left: path === null ? paths.length : paths.length - 1 };
}

/** What the front tab is, as far as a drop is concerned. */
export interface DropTab {
  kind: string;
  schema?: string;
  name?: string;
  objectKind?: string;
}

/** Where a dropped file goes: into the table in front, or else as a new table. */
export function dropTarget(
  front: DropTab | null,
  currentSchema: string | null,
): { schema: string; table: string | null } {
  if (
    front?.kind === "table" &&
    (front.objectKind === "table" || front.objectKind === "partitionedTable") &&
    front.schema &&
    front.name
  ) {
    return { schema: front.schema, table: front.name };
  }
  return { schema: currentSchema ?? "public", table: null };
}

/** The line the drop overlay shows for a seed. */
export function dropPrompt(target: { schema: string; table: string | null }): string {
  return target.table === null
    ? `Drop to import as a new table in ${target.schema}`
    : `Drop to import into ${target.schema}.${target.table}`;
}

/** The line shown when a drop can't be used. */
export function refusal(paths: readonly string[]): string {
  return paths.length === 1
    ? "That file can't be imported. Use a CSV, TSV or JSON file."
    : "None of those files can be imported. Use a CSV, TSV or JSON file.";
}
