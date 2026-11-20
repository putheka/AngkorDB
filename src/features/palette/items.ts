import type { DbObject, ObjectKind } from "@/bindings";
import { GROUPS, isOpenable } from "@/features/sidebar/treeRows";
import { fuzzyMatch } from "@/lib/fuzzy";

/** An item that matched the search, with the letters to draw in bold. */
export interface Match<T> {
  item: T;
  /** Positions in the item's label. */
  indices: number[];
  score: number;
}

/** Rows drawn for a search: enough to scroll, few enough to stay instant. */
export const MAX_ROWS = 50;
/** Rows drawn before anything is typed. It is only a starting point, so it is shorter: opening is what must be fast. */
export const START_ROWS = 30;

/** A remembered object. Only what is needed to find it again. */
export interface Recent {
  schema: string;
  name: string;
  kind: ObjectKind;
}

const kindOrder = (kind: ObjectKind) => GROUPS.findIndex((g) => g.kinds.includes(kind));

/**
 * A key that plain `<` sorts the way people expect: case-insensitive, `t2` before `t10`.
 * `Intl.Collator` gives the same order but costs far too much to call 10,000 times on opening.
 */
const sortKey = (text: string) =>
  text.toLowerCase().replace(/\d+/g, (digits) => digits.padStart(12, "0"));
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Objects matching `query`, best first. A query with a dot (`billing.inv`) is matched against
 * `schema.name`, anything else against the name alone.
 */
export function matchObjects(objects: readonly DbObject[], query: string): Match<DbObject>[] {
  const needle = query.trim();
  if (!needle) return [];
  const qualified = needle.includes(".");

  const matches: (Match<DbObject> & { key: string })[] = [];
  for (const object of objects) {
    const text = qualified ? `${object.schema}.${object.name}` : object.name;
    const found = fuzzyMatch(needle, text);
    if (!found) continue;
    // Bold only what falls in the name, which is the part drawn bold.
    const offset = qualified ? object.schema.length + 1 : 0;
    const indices = found.indices.filter((i) => i >= offset).map((i) => i - offset);
    matches.push({ item: object, indices, score: found.score, key: sortKey(object.name) });
  }
  matches.sort((a, b) => b.score - a.score || byKey(a.key, b.key));
  return matches.slice(0, MAX_ROWS).map(({ item, indices, score }) => ({ item, indices, score }));
}

/** With nothing typed: tables and views first, then the rest, each A to Z. */
export function defaultObjects(objects: readonly DbObject[]): DbObject[] {
  return objects
    .map((object) => ({
      object,
      key: `${kindOrder(object.kind)}\u0000${sortKey(object.schema)}\u0000${sortKey(object.name)}`,
    }))
    .sort((a, b) => byKey(a.key, b.key))
    .slice(0, START_ROWS)
    .map((entry) => entry.object);
}

/** The remembered objects that still exist, most recent first. */
export function resolveRecents(
  recents: readonly Recent[],
  objects: readonly DbObject[],
): DbObject[] {
  const byKey = new Map(objects.filter((o) => isOpenable(o.kind)).map((o) => [identity(o), o]));
  return recents.flatMap((r) => {
    const object = byKey.get(identity(r));
    return object ? [object] : [];
  });
}

const identity = (o: { schema: string; name: string }) => `${o.schema}.${o.name}`;

/** Filter and rank any list by a label. An empty query keeps everything in its order. */
export function matchLabels<T>(
  items: readonly T[],
  label: (item: T) => string,
  query: string,
): Match<T>[] {
  const needle = query.trim();
  if (!needle) return items.map((item) => ({ item, indices: [], score: 0 }));
  const matches: Match<T>[] = [];
  for (const item of items) {
    const found = fuzzyMatch(needle, label(item));
    if (found) matches.push({ item, indices: found.indices, score: found.score });
  }
  return matches.sort((a, b) => b.score - a.score);
}

/** Add `entry` in front, drop an older copy of it, keep the newest few. */
export function pushRecent(recents: readonly Recent[], entry: Recent, limit = 8): Recent[] {
  return [entry, ...recents.filter((r) => identity(r) !== identity(entry))].slice(0, limit);
}
