import type { DbObject, ObjectKind } from "@/bindings";
import { fuzzyMatch } from "@/lib/fuzzy";

export type GroupId =
  "tables" | "views" | "materializedViews" | "functions" | "sequences" | "types";

export const GROUPS: { id: GroupId; label: string; kinds: ObjectKind[] }[] = [
  { id: "tables", label: "Tables", kinds: ["table", "partitionedTable", "foreignTable"] },
  { id: "views", label: "Views", kinds: ["view"] },
  { id: "materializedViews", label: "Materialized views", kinds: ["materializedView"] },
  { id: "functions", label: "Functions", kinds: ["function", "procedure"] },
  { id: "sequences", label: "Sequences", kinds: ["sequence"] },
  { id: "types", label: "Types", kinds: ["enumType"] },
];

/** Kinds that have rows to show, so clicking them opens a tab. */
const OPENABLE: ObjectKind[] = [
  "table",
  "partitionedTable",
  "foreignTable",
  "view",
  "materializedView",
];
export const isOpenable = (kind: ObjectKind) => OPENABLE.includes(kind);

export type TreeRow =
  | { type: "group"; id: GroupId; label: string; count: number; collapsed: boolean }
  | { type: "object"; key: string; object: DbObject; indices: number[] };

/** Overloaded functions share a name and kind, but not an OID. */
export const objectKey = (object: DbObject) => `${object.kind}:${object.oid}`;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The flat list the sidebar renders. Without a query: every group, A to Z, unless collapsed.
 * With one: only matching objects, best match first, and every group open.
 */
export function buildRows(
  objects: readonly DbObject[],
  query: string,
  collapsed: ReadonlySet<GroupId>,
): TreeRow[] {
  const needle = query.trim();
  const rows: TreeRow[] = [];

  for (const group of GROUPS) {
    const members = objects.filter((o) => group.kinds.includes(o.kind));
    const matches = needle
      ? members.flatMap((object) => {
          const match = fuzzyMatch(needle, object.name);
          return match ? [{ object, ...match }] : [];
        })
      : members.map((object) => ({ object, score: 0, indices: [] as number[] }));
    if (matches.length === 0) continue;

    matches.sort((a, b) =>
      needle && a.score !== b.score
        ? b.score - a.score
        : collator.compare(a.object.name, b.object.name),
    );

    const isCollapsed = !needle && collapsed.has(group.id);
    rows.push({
      type: "group",
      id: group.id,
      label: group.label,
      count: matches.length,
      collapsed: isCollapsed,
    });
    if (isCollapsed) continue;
    for (const { object, indices } of matches) {
      rows.push({ type: "object", key: objectKey(object), object, indices });
    }
  }
  return rows;
}
