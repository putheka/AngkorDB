import type { RowPage } from "@/bindings";
import { omit } from "@/lib/omit";

/**
 * What a cell is to become. Every value is text and stays text until the server casts it
 * (ANG-8 D7: `$1::text::<type>`), so a bigint above 2^53 or a numeric survives untouched.
 */
export type CellValue = { kind: "value"; text: string } | { kind: "null" } | { kind: "default" };

/** How the server finds a row again when the change is applied (ANG-8 D2). */
export type RowRef =
  { kind: "key"; columns: string[]; values: string[] } | { kind: "ctid"; ctid: string };

/** The edits of one row. */
export interface RowChange {
  key: string;
  ref: RowRef;
  /** What each edited cell held when it was first edited, to tell "back to the original". */
  original: Record<string, string | null>;
  values: Record<string, CellValue>;
}

/** Everything staged for one table tab. Nothing reaches the database until it is applied. */
export interface ChangeSet {
  updates: Record<string, RowChange>;
}

export const EMPTY_CHANGES: ChangeSet = { updates: {} };

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
  if (Object.keys(row.values).length === 0) return { updates: omit(changes.updates, row.key) };
  return { updates: { ...changes.updates, [row.key]: row } };
}

/** Edited cells. */
export const pendingCells = (changes: ChangeSet) =>
  Object.values(changes.updates).reduce((n, row) => n + Object.keys(row.values).length, 0);

/** Rows with at least one edited cell. */
export const pendingRows = (changes: ChangeSet) => Object.keys(changes.updates).length;

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
  if (pendingRows(changes) === 0) return overrides;
  refs.forEach((ref, row) => {
    const change = ref ? changes.updates[keyOf(ref)] : undefined;
    if (!change) return;
    for (const [name, value] of Object.entries(change.values)) {
      const column = page.columns.findIndex((c) => c.name === name);
      if (column !== -1) overrides.set(`${row}:${column}`, value);
    }
  });
  return overrides;
}
