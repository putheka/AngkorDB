/** A copy of `record` without `key`. */
export function omit<V>(record: Record<string, V>, key: string): Record<string, V> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}
