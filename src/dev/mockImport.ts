/** A pretend import for the in-browser mock: the file is made up from its name. */
import type { ImportPreview, ImportRequest, ImportStatus, PreviewRequest } from "@/bindings";
import { appError } from "@/dev/mockSupport";

const COLUMNS = ["id", "name", "score", "joined", "active"];
const TYPES = ["integer", "text", "numeric", "date", "boolean"];

export function mockPreview(request: PreviewRequest): ImportPreview {
  if (request.path.includes("missing")) {
    throw appError("VALIDATION", `There is no file at ${request.path}.`);
  }
  if (request.path.includes("notutf8")) {
    throw appError(
      "VALIDATION",
      "Line 2 is not valid UTF-8. Save the file as UTF-8 and try again.",
    );
  }
  const rows = Array.from({ length: 50 }, (_, i) => [
    String(i + 1),
    `Person ${i + 1}`,
    (i * 1.5).toFixed(1),
    `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
    i % 2 === 0 ? "true" : "false",
  ]);
  return {
    columns: COLUMNS,
    rows,
    suggestedTypes: TYPES,
    fileBytes: 120 * 40,
    moreRows: true,
  };
}

interface Job {
  startedAt: number;
  cancelledAt: number | null;
  request: ImportRequest;
}

const jobs = new Map<string, Job>();
const TOTAL = 800_000;
const SPEED = 250_000;

export function startMockImport(request: ImportRequest): string {
  const id = crypto.randomUUID();
  jobs.set(id, { startedAt: Date.now(), cancelledAt: null, request });
  return id;
}

export function cancelMockImport(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelledAt ??= Date.now();
  return true;
}

export function mockImportStatus(id: string): ImportStatus {
  const job = jobs.get(id);
  if (!job) throw appError("NOT_FOUND", `import ${id} not found`);
  const now = job.cancelledAt ?? Date.now();
  const rows = Math.min(TOTAL, Math.floor(((now - job.startedAt) / 1000) * SPEED));
  const target = job.request.target;
  const base = {
    rowsRead: rows,
    rowsWritten: 0,
    rowsSkipped: 0,
    bytesRead: rows * 45,
    bytesTotal: TOTAL * 45,
    errors: [],
    moreErrors: false,
    error: null,
    table: `${target.schema}.${target.table}`,
  };
  const skipping = job.request.onError === "skip";
  const failing = job.request.path.includes("bad");
  if (job.cancelledAt !== null && rows < TOTAL) return { ...base, state: "cancelled" };
  if (rows < TOTAL) return { ...base, state: "running" };
  if (failing && !skipping) {
    return {
      ...base,
      state: "failed",
      error: {
        code: "VALIDATION",
        message: 'Line 5: invalid input syntax for type integer: "abc" (column id)',
        pgCode: null,
        detail: null,
        hint: null,
        position: null,
      },
      errors: [
        { at: "line 5", message: 'invalid input syntax for type integer: "abc" (column id)' },
      ],
    };
  }
  return {
    ...base,
    state: "done",
    rowsWritten: failing ? TOTAL - 2 : TOTAL,
    rowsSkipped: failing ? 2 : 0,
    errors: failing
      ? [
          { at: "line 5", message: 'invalid input syntax for type integer: "abc"' },
          { at: "line 91", message: 'null value in column "name" violates not-null constraint' },
        ]
      : [],
  };
}
