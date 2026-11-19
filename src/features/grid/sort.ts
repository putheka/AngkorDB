import type { SortSpec } from "@/bindings";

/**
 * What a click on a column header does to the sort. Each click moves the column one step:
 * none → ascending → descending → none. A plain click sorts by that column alone; with `add`
 * (shift-click) the column joins the other sorts, in the order they were added.
 */
export function nextSort(current: SortSpec[], column: string, add: boolean): SortSpec[] {
  const existing = current.find((s) => s.column === column);
  const dir = existing === undefined ? "asc" : existing.dir === "asc" ? "desc" : null;
  const entry: SortSpec[] = dir ? [{ column, dir }] : [];

  if (!add) return entry;
  if (!existing) return [...current, ...entry];
  return current.flatMap((s) => (s.column === column ? entry : [s]));
}

/** `1`, `2`, … as small raised digits, to number the sorts of a multi-column sort. */
export function superscript(n: number): string {
  const digits = "⁰¹²³⁴⁵⁶⁷⁸⁹";
  return String(n)
    .split("")
    .map((d) => digits.charAt(Number(d)))
    .join("");
}
