import type { ColumnInfo, IncomingForeignKey } from "@/bindings";

/**
 * One foreign key of this table, with every column it uses: `pairs` says which column of this
 * table holds which column of the target. A composite key has several; a column of a single-column
 * key is its own group of one.
 */
export interface ForeignKeyGroup {
  constraint: string;
  schema: string;
  table: string;
  pairs: { column: string; target: string }[];
}

/** The foreign keys of a table, rebuilt from the per-column references the catalog gives. */
export function foreignKeyGroups(columns: readonly ColumnInfo[]): ForeignKeyGroup[] {
  const groups = new Map<string, ForeignKeyGroup>();
  for (const column of columns) {
    for (const ref of column.foreignKeys) {
      const key = `${ref.schema}.${ref.table}/${ref.constraint}`;
      let group = groups.get(key);
      if (!group) {
        group = { constraint: ref.constraint, schema: ref.schema, table: ref.table, pairs: [] };
        groups.set(key, group);
      }
      group.pairs.push({ column: column.name, target: ref.column });
    }
  }
  return [...groups.values()];
}

/** The group a column belongs to (the first, in the rare case it is in several). */
export const groupOf = (groups: readonly ForeignKeyGroup[], column: string) =>
  groups.find((g) => g.pairs.some((p) => p.column === column));

/** Every column that is part of a foreign key. */
export const foreignKeyColumns = (groups: readonly ForeignKeyGroup[]): ReadonlySet<string> =>
  new Set(groups.flatMap((g) => g.pairs.map((p) => p.column)));

/** `users`, or `billing.invoices` when it is not in the schema being looked at. */
export const tableLabel = (schema: string, table: string, current: string) =>
  schema === current ? table : `${schema}.${table}`;

/** The columns of the row that other tables point at, for "referenced by". */
export const referencedValues = (
  fk: IncomingForeignKey,
  valueOf: (column: string) => string | null,
): string[] | null => {
  const values = fk.referencedColumns.map(valueOf);
  return values.every((v): v is string => v !== null) ? values : null;
};
