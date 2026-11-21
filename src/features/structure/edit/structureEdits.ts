/**
 * What the person has staged in the Structure view (ANG-37), and how it turns into the list of
 * changes the backend plans and runs.
 *
 * Every function takes the staged edits and returns new ones; nothing is changed in place. Edits
 * to an existing column are kept **normalized**: a field that is back to what the column already
 * is gets dropped, so an edit that undoes itself leaves nothing behind.
 *
 * Only `import type` from other modules: this runs under plain Node in the unit tests.
 */
import type {
  IndexColumn,
  IndexMethod,
  RefAction,
  StructureChange,
  StructureColumn,
} from "../../../bindings.ts";

/** What differs from the column as it is. Missing means untouched. */
export interface ColumnEdit {
  name?: string;
  typeName?: string;
  /** How to convert the old values when the type changes. */
  using?: string;
  nullable?: boolean;
  /** `null`: no default. */
  defaultValue?: string | null;
  /** `null`: no comment. */
  comment?: string | null;
}

export interface NewColumn {
  id: number;
  name: string;
  typeName: string;
  nullable: boolean;
  defaultValue: string;
  comment: string;
}

export interface NewIndex {
  id: number;
  name: string;
  method: IndexMethod;
  columns: IndexColumn[];
  unique: boolean;
  whereClause: string;
  concurrently: boolean;
}

export type NewConstraint =
  | { id: number; kind: "primaryKey"; name: string; columns: string[] }
  | { id: number; kind: "unique"; name: string; columns: string[] }
  | { id: number; kind: "check"; name: string; expression: string; notValid: boolean }
  | {
      id: number;
      kind: "foreignKey";
      name: string;
      columns: string[];
      refSchema: string;
      refTable: string;
      refColumns: string[];
      onDelete: RefAction;
      onUpdate: RefAction;
      notValid: boolean;
    };

export interface StructureEdits {
  /** By the column's name in the database. */
  columns: Record<string, ColumnEdit>;
  droppedColumns: string[];
  newColumns: NewColumn[];
  droppedIndexes: string[];
  newIndexes: NewIndex[];
  droppedConstraints: string[];
  newConstraints: NewConstraint[];
}

export const EMPTY_EDITS: StructureEdits = {
  columns: {},
  droppedColumns: [],
  newColumns: [],
  droppedIndexes: [],
  newIndexes: [],
  droppedConstraints: [],
  newConstraints: [],
};

/** A copy of `record` without `key` (this file takes no alias imports, so no `@/lib/omit`). */
const omitKey = <V>(record: Record<string, V>, key: string): Record<string, V> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const toggle = (list: readonly string[], name: string) =>
  list.includes(name) ? list.filter((n) => n !== name) : [...list, name];

// ---- Columns -----------------------------------------------------------------------------------

const blankToNull = (text: string | null | undefined) => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Merge `patch` into the staged edit of `original`, keeping only what really differs. */
export function editColumn(
  edits: StructureEdits,
  original: StructureColumn,
  patch: ColumnEdit,
): StructureEdits {
  const merged: ColumnEdit = { ...edits.columns[original.name], ...patch };
  const next: ColumnEdit = {};

  const name = merged.name?.trim();
  if (name !== undefined && name !== "" && name !== original.name) next.name = name;

  const typeName = merged.typeName?.trim();
  if (typeName !== undefined && typeName !== "" && typeName !== original.typeName) {
    next.typeName = typeName;
    const using = merged.using?.trim();
    if (using) next.using = using;
  }

  if (merged.nullable !== undefined && merged.nullable !== original.nullable) {
    next.nullable = merged.nullable;
  }

  if (merged.defaultValue !== undefined) {
    const value = blankToNull(merged.defaultValue);
    if (value !== (original.defaultValue ?? null)) next.defaultValue = value;
  }
  if (merged.comment !== undefined) {
    const value =
      merged.comment === null ? null : merged.comment.trim() === "" ? null : merged.comment;
    if (value !== (original.comment ?? null)) next.comment = value;
  }

  const columns =
    Object.keys(next).length === 0
      ? omitKey(edits.columns, original.name)
      : { ...edits.columns, [original.name]: next };
  return { ...edits, columns };
}

/** Throw away the edit of one column. */
export function revertColumn(edits: StructureEdits, name: string): StructureEdits {
  return { ...edits, columns: omitKey(edits.columns, name) };
}

export const toggleDropColumn = (edits: StructureEdits, name: string): StructureEdits => ({
  ...edits,
  droppedColumns: toggle(edits.droppedColumns, name),
});

export const addNewColumn = (edits: StructureEdits, column: NewColumn): StructureEdits => ({
  ...edits,
  newColumns: [...edits.newColumns, column],
});

export const updateNewColumn = (
  edits: StructureEdits,
  id: number,
  patch: Partial<Omit<NewColumn, "id">>,
): StructureEdits => ({
  ...edits,
  newColumns: edits.newColumns.map((c) => (c.id === id ? { ...c, ...patch } : c)),
});

export const removeNewColumn = (edits: StructureEdits, id: number): StructureEdits => ({
  ...edits,
  newColumns: edits.newColumns.filter((c) => c.id !== id),
});

// ---- Indexes and constraints -------------------------------------------------------------------

export const toggleDropIndex = (edits: StructureEdits, name: string): StructureEdits => ({
  ...edits,
  droppedIndexes: toggle(edits.droppedIndexes, name),
});

export const addNewIndex = (edits: StructureEdits, index: NewIndex): StructureEdits => ({
  ...edits,
  newIndexes: [...edits.newIndexes, index],
});

export const removeNewIndex = (edits: StructureEdits, id: number): StructureEdits => ({
  ...edits,
  newIndexes: edits.newIndexes.filter((i) => i.id !== id),
});

export const toggleDropConstraint = (edits: StructureEdits, name: string): StructureEdits => ({
  ...edits,
  droppedConstraints: toggle(edits.droppedConstraints, name),
});

export const addNewConstraint = (
  edits: StructureEdits,
  constraint: NewConstraint,
): StructureEdits => ({
  ...edits,
  newConstraints: [...edits.newConstraints, constraint],
});

export const removeNewConstraint = (edits: StructureEdits, id: number): StructureEdits => ({
  ...edits,
  newConstraints: edits.newConstraints.filter((c) => c.id !== id),
});

// ---- What is staged ----------------------------------------------------------------------------

/** How many changes there are to save. */
export function editCount(edits: StructureEdits): number {
  const altered = Object.keys(edits.columns).filter((c) => !edits.droppedColumns.includes(c));
  return (
    altered.length +
    edits.droppedColumns.length +
    edits.newColumns.length +
    edits.droppedIndexes.length +
    edits.newIndexes.length +
    edits.droppedConstraints.length +
    edits.newConstraints.length
  );
}

/** "2 columns changed · 1 column added · 1 index dropped" */
export function describeEdits(edits: StructureEdits): string {
  const altered = Object.keys(edits.columns).filter(
    (c) => !edits.droppedColumns.includes(c),
  ).length;
  const parts: [number, string, string][] = [
    [altered, "column", "changed"],
    [edits.newColumns.length, "column", "added"],
    [edits.droppedColumns.length, "column", "dropped"],
    [edits.newIndexes.length, "index", "added"],
    [edits.droppedIndexes.length, "index", "dropped"],
    [edits.newConstraints.length, "constraint", "added"],
    [edits.droppedConstraints.length, "constraint", "dropped"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(
      ([n, noun, what]) =>
        `${n} ${n === 1 ? noun : noun === "index" ? "indexes" : `${noun}s`} ${what}`,
    )
    .join(" · ");
}

/** The column names there will be after saving, for the pickers of an index or a constraint. */
export function finalColumnNames(
  columns: readonly StructureColumn[],
  edits: StructureEdits,
): string[] {
  const kept = columns
    .filter((c) => !edits.droppedColumns.includes(c.name))
    .map((c) => edits.columns[c.name]?.name ?? c.name);
  return [...kept, ...edits.newColumns.map((c) => c.name.trim()).filter((n) => n !== "")];
}

/** Mistakes to point out before the SQL is even asked for. */
export function problems(edits: StructureEdits, columns: readonly StructureColumn[]): string[] {
  const found: string[] = [];
  const names = finalColumnNames(columns, edits);
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) found.push(`Two columns would be called "${name}".`);
    seen.add(name);
  }
  for (const column of edits.newColumns) {
    if (column.name.trim() === "") found.push("A new column has no name.");
    if (column.typeName.trim() === "") {
      found.push(`The new column "${column.name || "?"}" has no type.`);
    }
  }
  for (const index of edits.newIndexes) {
    if (index.columns.length === 0) found.push("A new index has no columns.");
  }
  return found;
}

// ---- The changes the backend runs --------------------------------------------------------------

const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/**
 * The staged edits as backend changes, in an order that works: constraints and indexes that go
 * first (they may hold on to a column), then altered columns, dropped columns, new columns, and
 * last the new indexes and constraints (which may use the new columns, under their new names).
 */
export function toChanges(edits: StructureEdits): StructureChange[] {
  const out: StructureChange[] = [];

  for (const name of edits.droppedConstraints) {
    out.push({ kind: "dropConstraint", name, cascade: false });
  }
  for (const name of edits.droppedIndexes) {
    out.push({ kind: "dropIndex", name, concurrently: false });
  }

  for (const [column, edit] of Object.entries(edits.columns)) {
    if (edits.droppedColumns.includes(column)) continue;
    out.push({
      kind: "alterColumn",
      column,
      newName: edit.name ?? null,
      typeName: edit.typeName ?? null,
      using: edit.using ? edit.using : null,
      nullable: edit.nullable ?? null,
      defaultValue:
        edit.defaultValue === undefined
          ? null
          : edit.defaultValue === null
            ? { kind: "drop" }
            : { kind: "set", expression: edit.defaultValue },
      comment:
        edit.comment === undefined
          ? null
          : edit.comment === null
            ? { kind: "clear" }
            : { kind: "set", text: edit.comment },
    });
  }
  for (const column of edits.droppedColumns) {
    out.push({ kind: "dropColumn", column, cascade: false });
  }
  for (const c of edits.newColumns) {
    out.push({
      kind: "addColumn",
      name: c.name.trim(),
      typeName: c.typeName.trim(),
      nullable: c.nullable,
      defaultValue: orNull(c.defaultValue),
      comment: c.comment === "" ? null : c.comment,
    });
  }

  for (const i of edits.newIndexes) {
    out.push({
      kind: "createIndex",
      name: orNull(i.name),
      method: i.method,
      columns: i.columns,
      unique: i.unique,
      whereClause: orNull(i.whereClause),
      concurrently: i.concurrently,
    });
  }
  for (const c of edits.newConstraints) {
    if (c.kind === "primaryKey") {
      out.push({ kind: "addPrimaryKey", name: orNull(c.name), columns: c.columns });
    } else if (c.kind === "unique") {
      out.push({ kind: "addUnique", name: orNull(c.name), columns: c.columns });
    } else if (c.kind === "check") {
      out.push({
        kind: "addCheck",
        name: orNull(c.name),
        expression: c.expression,
        notValid: c.notValid,
      });
    } else {
      out.push({
        kind: "addForeignKey",
        name: orNull(c.name),
        columns: c.columns,
        refSchema: c.refSchema,
        refTable: c.refTable,
        refColumns: c.refColumns,
        onDelete: c.onDelete,
        onUpdate: c.onUpdate,
        notValid: c.notValid,
      });
    }
  }
  return out;
}

// ---- Text the person types ---------------------------------------------------------------------

/** Split at the commas that are not inside brackets or quotes: `a, lower(b, c), "d,e"`. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const QUOTED_NAME = /^"((?:[^"]|"")+)"$/;

/**
 * `user_id, lower(email) DESC, "Odd Name"` as index columns: a plain or quoted name is a column,
 * anything else is an expression; a trailing `ASC` or `DESC` is the direction.
 */
export function parseIndexColumns(text: string): IndexColumn[] {
  return splitTopLevel(text).map((item) => {
    const direction = /^(.*?)\s+(asc|desc)$/i.exec(item);
    const descending = direction?.[2]?.toLowerCase() === "desc";
    const body = (direction?.[1] ?? item).trim();
    const quoted = QUOTED_NAME.exec(body);
    if (quoted) {
      return { text: (quoted[1] ?? "").replace(/""/g, '"'), isExpression: false, descending };
    }
    if (PLAIN_NAME.test(body)) return { text: body, isExpression: false, descending };
    return { text: body, isExpression: true, descending };
  });
}

/** The name as SQL: quoted only when it has to be. */
export function quoteIfNeeded(name: string): string {
  return PLAIN_NAME.test(name) && name === name.toLowerCase()
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/** A first guess for `USING` when a column changes type: the column cast to the new type. */
export function suggestUsing(column: string, typeName: string): string {
  return `${quoteIfNeeded(column)}::${typeName.trim()}`;
}
