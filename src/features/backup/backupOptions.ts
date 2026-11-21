/** The backup and restore forms: the requests they become, and what to tell about the tools. */
import type {
  BackupFormat,
  BackupRequest,
  PgTools,
  RestoreRequest,
  ToolStatus,
} from "../../bindings.ts";

export type Scope = "everything" | "schema" | "data";

export interface BackupForm {
  format: BackupFormat;
  scope: Scope;
  /** One name or pattern per line or separated by commas. */
  include: string;
  exclude: string;
  /** 0 to 9 as typed; blank is the program's default. */
  compression: string;
  noOwner: boolean;
}

export const defaultBackupForm: BackupForm = {
  format: "custom",
  scope: "everything",
  include: "",
  exclude: "",
  compression: "",
  noOwner: true,
};

export const FORMATS: { value: BackupFormat; label: string; hint: string }[] = [
  {
    value: "custom",
    label: "Custom (.dump)",
    hint: "Compressed. Restore can pick tables and run in parallel.",
  },
  { value: "plain", label: "Plain SQL (.sql)", hint: "A script to read or run with psql." },
  {
    value: "directory",
    label: "Directory",
    hint: "One file per table; can be backed up and restored in parallel.",
  },
  { value: "tar", label: "Tar (.tar)", hint: "An archive, without compression." },
];

export const extensionOf = (format: BackupFormat): string =>
  ({ custom: "dump", plain: "sql", directory: "", tar: "tar" })[format];

/** `shop-2026-01-02.dump`: a name for the save dialog. */
export function defaultFileName(database: string, format: BackupFormat, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  const clean = database.replace(/[/\\:\0]/g, "_") || "backup";
  const extension = extensionOf(format);
  return extension ? `${clean}-${day}.${extension}` : `${clean}-${day}`;
}

/** Table names or patterns, one per line or comma-separated, blanks dropped. */
export function listOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

/** What is wrong with the form, in words; `null` when it can be sent. */
export function backupProblem(form: BackupForm): string | null {
  const text = form.compression.trim();
  if (text !== "") {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0 || n > 9) return "Compression is a whole number from 0 to 9.";
  }
  for (const name of [...listOf(form.include), ...listOf(form.exclude)]) {
    if (name.startsWith("-")) return `"${name}" is not a table name.`;
  }
  return null;
}

export function toBackupRequest(
  form: BackupForm,
  path: string,
  toolsDir: string | null,
  database: string | null,
): BackupRequest {
  const text = form.compression.trim();
  return {
    toolsDir,
    database,
    path,
    format: form.format,
    schemaOnly: form.scope === "schema",
    dataOnly: form.scope === "data",
    includeTables: listOf(form.include),
    excludeTables: listOf(form.exclude),
    compression: text === "" ? null : Number(text),
    noOwner: form.noOwner,
  };
}

export interface RestoreForm {
  /** A new database (`false`: one that exists). */
  intoNew: boolean;
  newName: string;
  existing: string;
  clean: boolean;
  noOwner: boolean;
  jobs: string;
}

export const defaultRestoreForm: RestoreForm = {
  intoNew: true,
  newName: "",
  existing: "",
  clean: false,
  noOwner: true,
  jobs: "4",
};

/** `shop-2026-01-02.dump` → `shop_2026_01_02_restored`: a name for the new database. */
export function databaseNameOf(path: string): string {
  const file = path.replace(/\/+$/, "").slice(path.replace(/\/+$/, "").lastIndexOf("/") + 1);
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
  const name = stem
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${name || "restored"}_restored`;
}

export function jobsOf(text: string): number {
  const n = Number(text.trim());
  return Number.isInteger(n) ? Math.min(16, Math.max(1, n)) : 1;
}

export function restoreProblem(form: RestoreForm): string | null {
  if (form.intoNew && form.newName.trim() === "") return "Give the new database a name.";
  if (!form.intoNew && form.existing === "") return "Choose the database to restore into.";
  const text = form.jobs.trim();
  if (text !== "" && (!Number.isInteger(Number(text)) || Number(text) < 1 || Number(text) > 16)) {
    return "Parallel jobs is a whole number from 1 to 16.";
  }
  return null;
}

export function toRestoreRequest(
  form: RestoreForm,
  path: string,
  toolsDir: string | null,
): RestoreRequest {
  return {
    toolsDir,
    path,
    target: form.intoNew
      ? { kind: "new", database: form.newName.trim() }
      : { kind: "existing", database: form.existing },
    clean: form.clean && !form.intoNew,
    noOwner: form.noOwner,
    jobs: jobsOf(form.jobs),
  };
}

/** The program to use for a server, and a warning when there is none that suits. */
export function toolsAdvice(
  tools: PgTools[],
  serverVersion: string | null,
): { tool: PgTools | null; warning: string | null } {
  const server = Number.parseInt(serverVersion ?? "", 10);
  if (tools.length === 0) {
    return {
      tool: null,
      warning:
        "pg_dump and pg_restore were not found. Install PostgreSQL (brew install postgresql@17) or choose the folder they are in.",
    };
  }
  if (!Number.isFinite(server)) return { tool: tools[0] ?? null, warning: null };
  // The closest version that is not older than the server; the list is newest first.
  const suited = [...tools].reverse().find((t) => t.major >= server) ?? null;
  if (suited) return { tool: suited, warning: null };
  return {
    tool: tools[0] ?? null,
    warning: `The newest pg_dump here is ${tools[0]?.version} but the server is PostgreSQL ${server}: it is too old to back it up. Install a newer one (brew install postgresql@${server}).`,
  };
}

const number = new Intl.NumberFormat("en-US");

export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** The line under the log while it runs, and after. */
export function progressText(status: ToolStatus, backup: boolean): string {
  const lines = `${number.format(Math.round(status.lines ?? 0))} lines of output`;
  return backup && (status.bytes ?? 0) > 0
    ? `${sizeText(status.bytes ?? 0)} written · ${lines}`
    : lines;
}
