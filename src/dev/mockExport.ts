/** A pretend export for the in-browser mock: rows and bytes grow with time, Cancel works. */
import type { ExportRequest, ExportStatus } from "@/bindings";
import { appError } from "@/dev/mockSupport";

interface MockJob {
  startedAt: number;
  /** Rows written per second. */
  speed: number;
  total: number;
  cancelledAt: number | null;
  request: ExportRequest;
  fail: boolean;
}

const jobs = new Map<string, MockJob>();

export function startMockExport(request: ExportRequest): string {
  if (request.path.trim() === "") throw appError("VALIDATION", "Choose where to save the file.");
  const source = request.source;
  const sql = source.kind === "query" ? source.sql : "";
  const id = crypto.randomUUID();
  jobs.set(id, {
    startedAt: Date.now(),
    speed: 250_000,
    // A table of a million rows takes a few seconds, so progress and Cancel can be tried.
    total:
      source.kind === "table" && source.table === "metrics_big"
        ? 1_000_000
        : source.kind === "tables"
          ? 600_000
          : 1_200,
    cancelledAt: null,
    request,
    fail: /no_such/.test(sql),
  });
  return id;
}

export function cancelMockExport(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelledAt ??= Date.now();
  return true;
}

export function mockExportStatus(id: string): ExportStatus {
  const job = jobs.get(id);
  if (!job) throw appError("NOT_FOUND", `export ${id} not found`);
  const now = job.cancelledAt ?? Date.now();
  const rows = Math.min(job.total, Math.floor(((now - job.startedAt) / 1000) * job.speed));
  const finished = rows >= job.total;
  const source = job.request.source;
  const base = {
    rows,
    bytes: rows * 56,
    estimatedRows: source.kind === "table" && source.filters.length === 0 ? job.total : null,
    current: source.kind === "table" ? `${source.schema}.${source.table}` : "query",
    files: [] as string[],
    error: null,
  };
  if (job.cancelledAt !== null && !finished) {
    return { ...base, state: "cancelled", current: null };
  }
  if (job.fail) {
    return {
      ...base,
      state: "failed",
      current: null,
      error: {
        code: "POSTGRES",
        message: 'relation "no_such_table" does not exist',
        pgCode: "42P01",
        detail: null,
        hint: null,
        position: null,
      },
    };
  }
  if (!finished) return { ...base, state: "running" };
  const files =
    source.kind === "tables"
      ? source.tables.map(
          (t) => `${job.request.path}/${t.schema}.${t.table}.${extensionOf(job.request)}`,
        )
      : [job.request.path];
  return { ...base, state: "done", current: null, files };
}

function extensionOf(request: ExportRequest): string {
  const format = request.format;
  switch (format.kind) {
    case "csv":
      return format.delimiter === "\t" ? "tsv" : "csv";
    case "json":
      return format.ndjson ? "ndjson" : "json";
    case "sql":
      return "sql";
    case "markdown":
      return "md";
  }
}
