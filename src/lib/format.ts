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

/** `205`, `12K`, `1.2M`: a size to put next to a name. */
export function formatCompact(count: number): string {
  return compactFormat.format(Math.round(count));
}

/** `812 B`, `16 KB`, `2.4 MB`, `1.2 GB`: a size on disk. Binary units, like `pg_size_pretty`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}
