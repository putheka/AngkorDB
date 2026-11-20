import type { ResultColumn, SortSpec } from "@/bindings";
import { isNumeric } from "@/features/grid/columns";

type Row = (string | null)[];

/**
 * Query results are sorted here, in the UI, because the server's result is a script's output,
 * not a table to re-query. Numbers compare as numbers, everything else as text; NULL goes last
 * when ascending and first when descending, as in Postgres.
 */
export function sortRows(columns: ResultColumn[], rows: Row[], sort: SortSpec[]): Row[] {
  const keys = sort.flatMap((spec) => {
    const index = columns.findIndex((c) => c.name === spec.column);
    const column = columns[index];
    return column ? [{ index, numeric: isNumeric(column), desc: spec.dir === "desc" }] : [];
  });
  if (keys.length === 0) return rows;

  return [...rows].sort((a, b) => {
    for (const { index, numeric, desc } of keys) {
      const x = a[index] ?? null;
      const y = b[index] ?? null;
      if (x === y) continue;
      let order: number;
      if (x === null) order = 1;
      else if (y === null) order = -1;
      else if (numeric && !Number.isNaN(Number(x)) && !Number.isNaN(Number(y))) {
        order = Number(x) < Number(y) ? -1 : Number(x) > Number(y) ? 1 : 0;
      } else order = x.localeCompare(y, undefined, { numeric: true });
      if (order !== 0) return desc ? -order : order;
    }
    return 0;
  });
}
