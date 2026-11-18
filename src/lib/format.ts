const exactFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** `205 rows`, `1 row`, `~1.2M rows` for an estimate. */
export function formatRowCount(count: number, exact: boolean): string {
  const rounded = Math.round(count);
  if (exact) return `${exactFormat.format(rounded)} ${rounded === 1 ? "row" : "rows"}`;
  return `~${compactFormat.format(rounded)} rows`;
}

/** `850 ms`, `1.4 s`, `2 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
