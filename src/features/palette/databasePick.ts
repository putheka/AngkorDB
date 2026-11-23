/** Choosing a database from a list of many (pure, so it can be tested). */

/** Add `name` in front, drop an older copy of it, keep the newest few. */
export function pushName(list: readonly string[], name: string, limit = 5): string[] {
  return [name, ...list.filter((n) => n !== name)].slice(0, limit);
}

/**
 * The databases opened last that still exist, newest first, without the one that is open (it is
 * marked in the full list).
 */
export function recentDatabases(
  recents: readonly string[],
  all: readonly string[],
  current: string | undefined,
): string[] {
  const known = new Set(all);
  return recents.filter((name) => known.has(name) && name !== current);
}
