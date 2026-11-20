import type { CellValue, ColumnInfo, RowPage, RowRef, TableChanges } from "@/bindings";
import { omit } from "@/lib/omit";

// `CellValue` (what a cell is to become: text, NULL or DEFAULT) and `RowRef` (how the server
// finds a row again) are the same types the Rust side applies (ANG-8 D2, D7). Every value is
// text until the server casts it, so a bigint above 2^53 or a numeric survives untouched.
export type { CellValue, RowRef };

/** The edits of one row. */
export interface RowChange {
  key: string;
  ref: RowRef;
  /** What each edited cell held when it was first edited, to tell "back to the original". */
  original: Record<string, string | null>;
  values: Record<string, CellValue>;
}

/** A row to be inserted. A column that is not in `values` gets its `DEFAULT`. */
export interface NewRow {
  /** Only for telling new rows apart in the UI; the server never sees it. */
  id: string;
  values: Record<string, CellValue>;
}

/** Everything staged for one table tab. Nothing reaches the database until it is applied. */
export interface ChangeSet {
  updates: Record<string, RowChange>;
  /** In the order they are inserted; the grid shows them above the page in this order. */
  inserts: NewRow[];
  /** Rows to delete, by `keyOf(ref)`. Their edits are kept (so undoing the delete brings them back) but not applied. */
  deletes: Record<string, RowRef>;
}

export const EMPTY_CHANGES: ChangeSet = { updates: {}, inserts: [], deletes: {} };

type PageLike = Pick<RowPage, "columns" | "rows" | "identity" | "ctids">;

/** The row's identity from what the server sent, or `null` when it can't be told apart. */
export function rowRefOf(page: PageLike, index: number): RowRef | null {
  const { identity } = page;
  if (identity.kind === "readOnly") return null;
  if (identity.kind === "ctid") {
    const ctid = page.ctids[index];
    return ctid === undefined ? null : { kind: "ctid", ctid };
  }
  const row = page.rows[index];
  if (!row) return null;
  const values: string[] = [];
  for (const name of identity.columns) {
    const at = page.columns.findIndex((c) => c.name === name);
    const value = row[at];
    if (value === null || value === undefined) return null; // a key is never NULL
    values.push(value);
  }
  return { kind: "key", columns: identity.columns, values };
}

/** A string that is the same for the same row, whatever page it is on. */
export function keyOf(ref: RowRef): string {
  return ref.kind === "ctid" ? `c:${ref.ctid}` : `k:${JSON.stringify(ref.values)}`;
}

const sameAsOriginal = (value: CellValue, original: string | null) =>
  (value.kind === "null" && original === null) ||
  (value.kind === "value" && value.text === original);

/**
 * Stage `value` for one cell. Putting a cell back to what it was removes the edit, and a row
 * with no edits left disappears from the set.
 */
export function setCell(
  changes: ChangeSet,
  ref: RowRef,
  column: string,
  original: string | null,
  value: CellValue,
): ChangeSet {
  const key = keyOf(ref);
  const row = changes.updates[key] ?? { key, ref, original: {}, values: {} };
  // The first edit of a cell fixes what "original" means; later edits compare against it.
  const baseline = column in row.original ? (row.original[column] ?? null) : original;

  if (sameAsOriginal(value, baseline)) {
    return withRow(changes, {
      ...row,
      values: omit(row.values, column),
      original: omit(row.original, column),
    });
  }
  return withRow(changes, {
    ...row,
    values: { ...row.values, [column]: value },
    original: { ...row.original, [column]: baseline },
  });
}

/** Undo the edit of one cell. */
export function revertCell(changes: ChangeSet, key: string, column: string): ChangeSet {
  const row = changes.updates[key];
  if (!row) return changes;
  return withRow(changes, {
    ...row,
    values: omit(row.values, column),
    original: omit(row.original, column),
  });
}

function withRow(changes: ChangeSet, row: RowChange): ChangeSet {
  if (Object.keys(row.values).length === 0) {
    return { ...changes, updates: omit(changes.updates, row.key) };
  }
  return { ...changes, updates: { ...changes.updates, [row.key]: row } };
}

/** Is this row marked for deletion? */
export const isDeleted = (changes: ChangeSet, ref: RowRef) => keyOf(ref) in changes.deletes;

/**
 * Mark rows for deletion, or take the mark off again: when every one of them is already marked
 * the mark is removed from all (pressing Delete twice undoes it), otherwise all get it.
 */
export function toggleDeleted(changes: ChangeSet, refs: readonly RowRef[]): ChangeSet {
  if (refs.length === 0) return changes;
  const everyMarked = refs.every((ref) => isDeleted(changes, ref));
  const deletes = { ...changes.deletes };
  for (const ref of refs) {
    if (everyMarked)
      delete deletes[keyOf(ref)]; // eslint-disable-line @typescript-eslint/no-dynamic-delete
    else deletes[keyOf(ref)] = ref;
  }
  return { ...changes, deletes };
}

export const addNewRow = (changes: ChangeSet, row: NewRow): ChangeSet => ({
  ...changes,
  inserts: [...changes.inserts, row],
});

/** Drop new rows altogether (they were never in the database). */
export const removeNewRows = (changes: ChangeSet, ids: ReadonlySet<string>): ChangeSet => ({
  ...changes,
  inserts: changes.inserts.filter((row) => !ids.has(row.id)),
});

/** Set a cell of a new row. `DEFAULT` is what a column has when nothing is set, so it just clears it. */
export function setNewCell(
  changes: ChangeSet,
  id: string,
  column: string,
  value: CellValue,
): ChangeSet {
  return {
    ...changes,
    inserts: changes.inserts.map((row) =>
      row.id !== id
        ? row
        : {
            ...row,
            values:
              value.kind === "default"
                ? omit(row.values, column)
                : { ...row.values, [column]: value },
          },
    ),
  };
}

/** A default that is made by the server, so a copy of the row should get its own. */
const isServerGenerated = (column: ColumnInfo) =>
  /nextval\(|gen_random_uuid|uuid_generate/i.test(column.defaultValue ?? "");

/**
 * The cells of a duplicated row: everything except what identifies the row or is made by the
 * server (primary key, identity, generated and serial / uuid-default columns). Those stay
 * `DEFAULT`, so the copy gets fresh ones instead of failing on a duplicate key.
 */
export function duplicateValues(
  columns: readonly ColumnInfo[],
  valueOf: (column: string) => CellValue,
): Record<string, CellValue> {
  const values: Record<string, CellValue> = {};
  for (const column of columns) {
    if (column.generated || column.identity !== null) continue;
    if (column.isPrimaryKey || isServerGenerated(column)) continue;
    const value = valueOf(column.name);
    if (value.kind !== "default") values[column.name] = value;
  }
  return values;
}

/** What `apply_changes` and `preview_changes` take. Edits of a row that is being deleted are left out. */
export function toTableChanges(changes: ChangeSet): TableChanges {
  return {
    updates: Object.values(changes.updates)
      .filter((row) => !(row.key in changes.deletes))
      .map((row) => ({ row: row.ref, values: row.values })),
    inserts: changes.inserts.map((row) => ({ values: row.values })),
    deletes: Object.values(changes.deletes),
  };
}

export interface PendingSummary {
  /** Edited cells and the rows they are in (rows being deleted don't count). */
  cells: number;
  rows: number;
  inserts: number;
  deletes: number;
  /** Everything there is to write. */
  total: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 edits in 1 row · 1 new row · 3 rows to delete" */
export function describePending(summary: PendingSummary): string {
  const parts: string[] = [];
  if (summary.cells > 0) {
    parts.push(`${plural(summary.cells, "edit")} in ${plural(summary.rows, "row")}`);
  }
  if (summary.inserts > 0) parts.push(`${plural(summary.inserts, "new row")}`);
  if (summary.deletes > 0) parts.push(`${plural(summary.deletes, "row")} to delete`);
  return parts.join(" · ");
}

export function summarize(changes: ChangeSet): PendingSummary {
  const edited = Object.values(changes.updates).filter((row) => !(row.key in changes.deletes));
  const cells = edited.reduce((n, row) => n + Object.keys(row.values).length, 0);
  const inserts = changes.inserts.length;
  const deletes = Object.keys(changes.deletes).length;
  return { cells, rows: edited.length, inserts, deletes, total: cells + inserts + deletes };
}

/**
 * The staged value of each edited cell of this page, as `"row:column"` → value, with the
 * column as an index into `page.columns`. Rows of other pages simply aren't in it.
 */
export function overridesFor(
  page: PageLike,
  refs: readonly (RowRef | null)[],
  changes: ChangeSet,
): Map<string, CellValue> {
  const overrides = new Map<string, CellValue>();
  if (Object.keys(changes.updates).length === 0) return overrides;
  refs.forEach((ref, row) => {
    const key = ref ? keyOf(ref) : undefined;
    // A row that is going away shows what it holds now, not what was typed into it.
    const change =
      key !== undefined && !(key in changes.deletes) ? changes.updates[key] : undefined;
    if (!change) return;
    for (const [name, value] of Object.entries(change.values)) {
      const column = page.columns.findIndex((c) => c.name === name);
      if (column !== -1) overrides.set(`${row}:${column}`, value);
    }
  });
  return overrides;
}
