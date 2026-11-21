/**
 * Small text helpers for the history list and the saved queries (ANG-33).
 * No imports from aliases at runtime: this runs under plain Node in the unit tests.
 */

/** The statement on one line: whitespace squeezed, cut at `max` characters with an ellipsis. */
export function oneLine(sql: string, max = 140): string {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

/** `just now`, `5 min ago`, `3 h ago`, `yesterday`, `4 days ago`, or a date after two weeks. */
export function formatAgo(ranAt: number | null, now: number): string {
  if (ranAt === null) return "";
  const seconds = Math.max(0, Math.round((now - ranAt) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return new Date(ranAt).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export interface Folderable {
  folder: string;
}

/** Saved queries by folder, keeping the order they come in; queries without a folder first. */
export function groupByFolder<T extends Folderable>(items: T[]): { folder: string; items: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const list = groups.get(item.folder);
    if (list) list.push(item);
    else groups.set(item.folder, [item]);
  }
  return [...groups]
    .map(([folder, list]) => ({ folder, items: list }))
    .sort((a, b) =>
      a.folder === b.folder
        ? 0
        : a.folder === ""
          ? -1
          : b.folder === ""
            ? 1
            : a.folder.localeCompare(b.folder, undefined, { sensitivity: "base" }),
    );
}

/** A name to suggest when saving: the statement's first words, e.g. `SELECT * FROM orders`. */
export function suggestName(sql: string): string {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  return oneLine(withoutComments, 40);
}
