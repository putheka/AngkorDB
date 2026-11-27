import type { ResultColumn } from "@/bindings";

/** Which columns are shown, in what order and how wide. Kept per tab, by column name. */
export interface ColumnLayout {
  /** Every column name in display order. Names that no longer exist are ignored. */
  order: string[];
  hidden: string[];
  widths: Record<string, number>;
}

export const EMPTY_LAYOUT: ColumnLayout = { order: [], hidden: [], widths: {} };

export interface VisibleColumn {
  /** Position in the result's `columns`, and in each row. */
  index: number;
  column: ResultColumn;
}

/** The columns to draw: the saved order first, new columns after it, hidden ones left out. */
export function visibleColumns(columns: ResultColumn[], layout: ColumnLayout): VisibleColumn[] {
  const all = columns.map((column, index) => ({ column, index }));
  const rank = new Map(layout.order.map((name, i) => [name, i]));
  const hidden = new Set(layout.hidden);
  return all
    .filter(({ column }) => !hidden.has(column.name))
    .sort((a, b) => {
      // Unknown names (new columns) sort after every saved one, in table order.
      const ra = rank.get(a.column.name) ?? layout.order.length + a.index;
      const rb = rank.get(b.column.name) ?? layout.order.length + b.index;
      return ra - rb;
    });
}

/** Every column name, in the order they would be shown if none were hidden. */
export function orderedNames(columns: ResultColumn[], layout: ColumnLayout): string[] {
  return visibleColumns(columns, { ...layout, hidden: [] }).map((v) => v.column.name);
}

/** The columns whose name or type holds every word of `query`; all of them when it is empty. */
export function matchColumns<T extends { name: string; typeName: string }>(
  columns: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return columns;
  return columns.filter((column) => {
    const text = `${column.name} ${column.typeName}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Show or hide `names`, leaving every other column as it was. */
export function withHidden(layout: ColumnLayout, names: string[], hide: boolean): ColumnLayout {
  const changing = new Set(names);
  const rest = layout.hidden.filter((name) => !changing.has(name));
  return { ...layout, hidden: hide ? [...rest, ...names] : rest };
}

/** Move `name` to where `target` is. The order of columns that are hidden is kept. */
export function moveColumn(names: string[], name: string, target: string): string[] {
  const from = names.indexOf(name);
  const to = names.indexOf(target);
  if (from === -1 || to === -1 || from === to) return names;
  const next = names.filter((n) => n !== name);
  next.splice(to, 0, name);
  return next;
}

// Postgres type OIDs that hold numbers: int8, int2, int4, oid, float4, float8, numeric.
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
export const isNumeric = (column: ResultColumn) => NUMERIC_OIDS.has(column.typeOid);
export const isBoolean = (column: ResultColumn) => column.typeOid === 16;
export const isJson = (column: ResultColumn) => column.typeOid === 114 || column.typeOid === 3802;

export const MIN_WIDTH = 60;
const MAX_AUTO_WIDTH = 320;
const SAMPLE_ROWS = 100;
const CHAR_WIDTH = 7.4;

/** A width that fits the title and what the first rows hold, within sane limits. */
export function autoWidth(column: ResultColumn, index: number, rows: (string | null)[][]): number {
  let longest = column.name.length + 4; // room for the sort arrow
  for (const row of rows.slice(0, SAMPLE_ROWS)) {
    const text = row[index];
    longest = Math.max(
      longest,
      Math.min(text === null || text === undefined ? 4 : text.length, 60),
    );
  }
  return Math.round(Math.min(Math.max(longest * CHAR_WIDTH + 28, 80), MAX_AUTO_WIDTH));
}
