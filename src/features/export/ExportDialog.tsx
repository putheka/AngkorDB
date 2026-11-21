import { useQuery } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ExportSource, Filter, SortSpec } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DELIMITERS,
  FORMATS,
  QUOTES,
  defaultExportForm,
  defaultFileName,
  extensionOf,
  formProblem,
  progressOf,
  toFormat,
  type ExportForm,
  type FormatKind,
} from "@/features/export/exportOptions";
import { useObjects } from "@/features/sidebar/useSchema";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { pickFolder, pickSavePath } from "@/lib/pickFile";
import { cn } from "@/lib/utils";

/** What the dialog starts from. */
export type ExportSeed =
  | {
      kind: "table";
      schema: string;
      table: string;
      /** The grid's filters, raw WHERE and sort: what is on screen is what is exported. */
      filters: Filter[];
      rawWhere: string | null;
      sort: SortSpec[];
    }
  | { kind: "query"; sql: string }
  /** A table picked in the sidebar; more can be ticked. */
  | { kind: "tables"; schema: string; first: string };

const TABLE_KINDS = ["table", "partitionedTable", "foreignTable", "view", "materializedView"];

interface Props {
  connectionId: string;
  seed: ExportSeed;
  onClose: () => void;
}

const SELECT = "h-8 rounded-lg border bg-background px-2 text-sm";

/** Export rows to a file: format and options, where to save, then progress with Cancel. */
export function ExportDialog({ connectionId, seed, onClose }: Props) {
  const [form, setForm] = useState<ExportForm>(defaultExportForm);
  const [path, setPath] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>(seed.kind === "tables" ? [seed.first] : []);
  const [exportId, setExportId] = useState<string | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const objects = useObjects(connectionId, seed.kind === "tables" ? seed.schema : null);
  const tables = (objects.data ?? []).filter((o) => TABLE_KINDS.includes(o.kind));
  const several = seed.kind === "tables" && ticked.length > 1;

  const status = useQuery({
    queryKey: ["export", exportId],
    queryFn: () => commands.exportStatus(exportId ?? ""),
    enabled: exportId !== null,
    // Keep asking when the window is in the background: an export goes on there.
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      query.state.data?.state === "running" || !query.state.data ? 250 : false,
    retry: false,
  });
  const running =
    exportId !== null && (status.data === undefined || status.data.state === "running");

  // Closing the dialog while it writes stops the export.
  const live = useRef({ exportId, running });
  useEffect(() => {
    live.current = { exportId, running };
  });
  useEffect(
    () => () => {
      const { exportId: id, running: busy } = live.current;
      if (id && busy) void commands.cancelExport(id);
    },
    [],
  );

  const set = (patch: Partial<ExportForm>) => setForm((f) => ({ ...f, ...patch }));
  const problem = formProblem(form);
  const baseName =
    seed.kind === "table"
      ? seed.table
      : seed.kind === "tables"
        ? (ticked[0] ?? seed.first)
        : "query_result";
  const folderMode = several;

  async function choose() {
    try {
      const chosen = folderMode
        ? await pickFolder("Folder for the files")
        : await pickSavePath("Export", defaultFileName(baseName, form), extensionOf(form));
      if (chosen) setPath(chosen);
    } catch (error) {
      setStartError(error);
    }
  }

  function source(): ExportSource {
    switch (seed.kind) {
      case "table":
        return {
          kind: "table",
          schema: seed.schema,
          table: seed.table,
          filters: seed.filters,
          rawWhere: seed.rawWhere,
          sort: seed.sort,
        };
      case "query":
        return { kind: "query", sql: seed.sql, name: form.tableName.trim() || null };
      case "tables":
        return ticked.length === 1
          ? {
              kind: "table",
              schema: seed.schema,
              table: ticked[0] ?? seed.first,
              filters: [],
              rawWhere: null,
              sort: [],
            }
          : {
              kind: "tables",
              tables: ticked.map((table) => ({ schema: seed.schema, table })),
            };
    }
  }

  async function start() {
    if (!path || problem) return;
    setStarting(true);
    setStartError(null);
    try {
      setExportId(
        await commands.startExport(connectionId, {
          source: source(),
          format: toFormat(form),
          path,
        }),
      );
    } catch (error) {
      setStartError(error);
    } finally {
      setStarting(false);
    }
  }

  async function stop() {
    if (exportId) await commands.cancelExport(exportId);
  }

  async function reveal(file: string) {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(file);
    } catch {
      // No Finder here (a plain browser).
    }
  }

  const finished = status.data && status.data.state !== "running" ? status.data : null;
  const progress = status.data ? progressOf(status.data) : null;
  const filtered = seed.kind === "table" && (seed.filters.length > 0 || seed.rawWhere !== null);
  const title =
    seed.kind === "table"
      ? `Export ${seed.table}`
      : seed.kind === "query"
        ? "Export the result"
        : "Export tables";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {seed.kind === "table" &&
              (filtered
                ? "The rows that match the filter, in the order of the grid: all of them, not just this page."
                : "Every row of the table, not just this page.")}
            {seed.kind === "query" &&
              "The query is run again for the export: every row, not just the ones shown."}
            {seed.kind === "tables" && "One file per table."}
          </DialogDescription>
        </DialogHeader>

        {exportId === null ? (
          <div className="flex flex-col gap-4">
            {seed.kind === "tables" && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-sm font-medium">Tables of {seed.schema}</legend>
                <div className="grid max-h-36 gap-x-4 gap-y-1 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
                  {tables.map((t) => (
                    <label key={t.oid} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={ticked.includes(t.name)}
                        onChange={(e) => {
                          setPath(null);
                          setTicked((now) =>
                            e.target.checked ? [...now, t.name] : now.filter((n) => n !== t.name),
                          );
                        }}
                      />
                      <span className="truncate">{t.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="export-format">Format</Label>
              <select
                id="export-format"
                className={SELECT}
                value={form.format}
                onChange={(e) => {
                  setPath(null);
                  set({ format: e.target.value as FormatKind });
                }}
              >
                {FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>

            {form.format === "csv" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-delimiter">Delimiter</Label>
                  <select
                    id="export-delimiter"
                    className={SELECT}
                    value={form.delimiter}
                    onChange={(e) => {
                      setPath(null);
                      set({ delimiter: e.target.value });
                    }}
                  >
                    {DELIMITERS.map((d) => (
                      <option key={d.value} value={d.value}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-quote">Quote</Label>
                  <select
                    id="export-quote"
                    className={SELECT}
                    value={form.quote}
                    onChange={(e) => set({ quote: e.target.value })}
                  >
                    {QUOTES.map((q) => (
                      <option key={q.value} value={q.value}>
                        {q.label}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.header}
                    onChange={(e) => set({ header: e.target.checked })}
                  />
                  First row has the column names
                </label>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-null">NULL is written as</Label>
                  <Input
                    id="export-null"
                    value={form.nullText}
                    onChange={(e) => set({ nullText: e.target.value })}
                    placeholder="Nothing"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
            )}
            {form.format === "json" && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.ndjson}
                  onChange={(e) => {
                    setPath(null);
                    set({ ndjson: e.target.checked });
                  }}
                />
                <span>
                  One object per line (NDJSON)
                  <span className="block text-xs text-muted-foreground">
                    Easy to stream and to load by line. Without it the file is one array.
                  </span>
                </span>
              </label>
            )}
            {form.format === "sql" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="export-batch">Rows per INSERT</Label>
                  <Input
                    id="export-batch"
                    value={form.batchSize}
                    onChange={(e) => set({ batchSize: e.target.value })}
                    inputMode="numeric"
                    autoComplete="off"
                  />
                </div>
                {seed.kind === "query" && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="export-table">Table name</Label>
                    <Input
                      id="export-table"
                      value={form.tableName}
                      onChange={(e) => set({ tableName: e.target.value })}
                      placeholder="query_result"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label>{folderMode ? "Folder" : "File"}</Label>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => void choose()}>
                  {folderMode ? "Choose folder…" : "Save as…"}
                </Button>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs",
                    !path && "text-muted-foreground",
                  )}
                  title={path ?? undefined}
                >
                  {path ?? "Nothing chosen yet"}
                </span>
              </div>
            </div>

            {problem && (
              <p role="alert" className="text-xs font-medium text-destructive">
                {problem}
              </p>
            )}
            {startError !== null && <Failure error={startError} />}
          </div>
        ) : (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(progress?.fraction != null
                ? { "aria-valuenow": Math.round(progress.fraction * 100) }
                : {})}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-primary transition-[width]",
                  progress?.fraction == null && running && "w-1/3 animate-pulse",
                )}
                style={
                  progress?.fraction != null ? { width: `${progress.fraction * 100}%` } : undefined
                }
              />
            </div>
            <p className="flex items-center gap-2 text-sm">
              {running && <Loader2Icon className="size-4 animate-spin" />}
              {finished?.state === "done" && (
                <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
              )}
              <span>
                {finished?.state === "done" && "Done · "}
                {finished?.state === "cancelled" && "Cancelled · "}
                {finished?.state === "failed" && "Stopped · "}
                {progress?.text ?? "Starting…"}
              </span>
            </p>
            {status.data?.current && running && (
              <p className="truncate text-xs text-muted-foreground">
                Writing {status.data.current}
              </p>
            )}
            {finished?.state === "done" && (
              <ul className="flex flex-col gap-1 text-xs">
                {finished.files.map((file) => (
                  <li key={file} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono select-text" title={file}>
                      {file}
                    </span>
                    <button
                      type="button"
                      onClick={() => void reveal(file)}
                      className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    >
                      Show in Finder
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {finished?.state === "cancelled" && (
              <p className="text-xs text-muted-foreground">The partly written file was removed.</p>
            )}
            {finished?.state === "failed" && finished.error && <Failure error={finished.error} />}
            {status.isError && <Failure error={status.error} />}
          </div>
        )}

        <DialogFooter>
          {exportId === null ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={
                  !path || !!problem || starting || (seed.kind === "tables" && ticked.length === 0)
                }
                onClick={() => void start()}
              >
                {starting ? "Starting…" : "Export"}
              </Button>
            </>
          ) : running ? (
            <Button type="button" variant="outline" onClick={() => void stop()}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Failure({ error }: { error: unknown }) {
  return (
    <div role="alert" className="text-xs">
      <p className="font-medium text-destructive">{errorMessage(error)}</p>
      {errorDetails(error).map((line) => (
        <p key={line} className="text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}
