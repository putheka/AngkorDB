/** Pretend pg_dump / pg_restore for the in-browser mock: output lines appear over time. */
import type { BackupRequest, PgTools, RestoreRequest, ToolStatus } from "@/bindings";
import { appError } from "@/dev/mockSupport";

export function mockPgTools(chosen: string | null): PgTools[] {
  const found: PgTools[] = [
    { dir: "/opt/homebrew/opt/postgresql@17/bin", version: "17.10", major: 17, source: "Homebrew" },
    {
      dir: "/Applications/Postgres.app/Contents/Versions/16/bin",
      version: "16.4",
      major: 16,
      source: "Postgres.app",
    },
  ];
  if (chosen && !found.some((t) => t.dir === chosen)) {
    return [{ dir: chosen, version: "15.6", major: 15, source: "Chosen folder" }, ...found];
  }
  return found;
}

interface Job {
  startedAt: number;
  cancelledAt: number | null;
  backup: boolean;
  command: string;
  output: string;
  failing: boolean;
}

const jobs = new Map<string, Job>();
const TABLES = ["app_settings", "event_log", "metrics_big", "order_items", "orders", "users"];
const DURATION_MS = 4000;

export function startMockBackup(request: BackupRequest): string {
  if (request.schemaOnly && request.dataOnly) {
    throw appError("VALIDATION", "Choose either the schema only or the data only, not both.");
  }
  const id = crypto.randomUUID();
  jobs.set(id, {
    startedAt: Date.now(),
    cancelledAt: null,
    backup: true,
    command: `pg_dump --verbose --no-password --dbname=${request.database ?? "angkordb_dev"} --format ${request.format} --file ${request.path}.part`,
    output: request.path,
    failing: false,
  });
  return id;
}

export function startMockRestore(request: RestoreRequest): string {
  const id = crypto.randomUUID();
  const database = request.target.database;
  jobs.set(id, {
    startedAt: Date.now(),
    cancelledAt: null,
    backup: false,
    command: `pg_restore --verbose --no-password --dbname=${database} ${request.path}`,
    output: database,
    failing: request.path.includes("bad"),
  });
  return id;
}

export function cancelMockTool(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelledAt ??= Date.now();
  return true;
}

export function mockToolStatus(id: string): ToolStatus {
  const job = jobs.get(id);
  if (!job) throw appError("NOT_FOUND", `job ${id} not found`);
  const now = job.cancelledAt ?? Date.now();
  const share = Math.min(1, (now - job.startedAt) / DURATION_MS);
  const program = job.backup ? "pg_dump" : "pg_restore";
  const verb = job.backup ? "dumping contents of table" : "processing data for table";
  const shown = Math.floor(share * TABLES.length);
  const log = [
    `${program}: ${job.backup ? "last built-in OID is 16383" : "connecting to database for restore"}`,
    ...TABLES.slice(0, shown).map((t) => `${program}: ${verb} "public.${t}"`),
  ];
  const base = {
    log,
    lines: log.length,
    bytes: job.backup ? Math.round(share * 31_000_000) : 0,
    command: job.command,
    output: job.output,
    error: null,
  };
  if (job.cancelledAt !== null && share < 1) return { ...base, state: "cancelled" };
  if (share < 1) return { ...base, state: "running" };
  if (job.failing) {
    return {
      ...base,
      state: "failed",
      error: {
        code: "INTERNAL",
        message:
          'pg_restore: error: could not execute query: ERROR:  relation "users" already exists',
        pgCode: null,
        detail: null,
        hint: null,
        position: null,
      },
    };
  }
  return { ...base, state: "done" };
}
