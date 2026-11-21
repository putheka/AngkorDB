import { useQuery } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { ImportPreview, NewColumn } from "@/bindings";
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
import { useConnections } from "@/features/connections/useConnections";
import { refreshData } from "@/features/grid/useTableData";
import {
  DELIMITERS,
  autoMapping,
  defaultImportForm,
  errorsText,
  formProblem,
  guessFormat,
  mappingList,
  newColumns,
  progressOf,
  tableNameOf,
  toFormat,
  toRequest,
  type ImportForm,
} from "@/features/import/importOptions";
import { confirmationMatches, needsTypedConfirmation } from "@/features/objects/createTable";
import { useWriteApproval } from "@/features/safety/approval";
import { refreshSchema } from "@/features/sidebar/useSchema";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { pickDataFile } from "@/lib/pickFile";
import { cn } from "@/lib/utils";
import type { ImportSeed } from "@/stores/importDialog";

const SELECT = "h-7 rounded-md border bg-background px-1.5 text-xs";

interface Props {
  connectionId: string;
  seed: ImportSeed;
  onClose: () => void;
}

/** Pick a file, look at it, say where each column goes, and import it. */
export function ImportDialog({ connectionId, seed, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const color = connections.find((c) => c.id === connectionId)?.color ?? "none";

  const [path, setPath] = useState<string | null>(seed.path ?? null);
  const [form, setForm] = useState<ImportForm>(() => ({
    ...defaultImportForm,
    ...(seed.path ? guessFormat(seed.path) : {}),
    intoExisting: seed.table !== null,
    newTable: seed.path ? tableNameOf(seed.path) : "",
  }));
  // Mapping and column choices the person changed; the rest follows the file.
  const [mapEdits, setMapEdits] = useState<Record<string, string | null>>({});
  const [columnEdits, setColumnEdits] = useState<Record<number, Partial<NewColumn>>>({});
  const [typed, setTyped] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const set = (patch: Partial<ImportForm>) => {
    setForm((f) => ({ ...f, ...patch }));
  };

  const preview = useQuery({
    queryKey: ["import-preview", path, JSON.stringify(toFormat(form))],
    queryFn: () => commands.previewImport({ path: path ?? "", format: toFormat(form) }),
    enabled: path !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const shown: ImportPreview | undefined = preview.data;

  const table = seed.table;
  const description = useQuery({
    queryKey: ["schema", connectionId, "describe", seed.schema, table],
    queryFn: () => commands.describeTable(connectionId, seed.schema, table ?? ""),
    enabled: table !== null,
  });
  const tableColumns = useMemo(
    () => (description.data?.columns ?? []).filter((c) => !c.generated).map((c) => c.name),
    [description.data],
  );

  const mapping = useMemo(() => {
    if (!shown) return {};
    return { ...autoMapping(shown.columns, tableColumns), ...mapEdits };
  }, [shown, tableColumns, mapEdits]);
  const columns: NewColumn[] = useMemo(
    () => (shown ? newColumns(shown).map((c, i) => ({ ...c, ...columnEdits[i] })) : []),
    [shown, columnEdits],
  );

  const mapped = mappingList(mapping).length;
  const problem = shown ? formProblem(form, mapped, columns) : null;
  const mustType = needsTypedConfirmation(color, form.intoExisting && form.truncate);
  const targetName = form.intoExisting ? (table ?? "") : form.newTable.trim();
  const ready =
    !!shown && !problem && (!mustType || confirmationMatches(typed, targetName)) && !starting;

  const status = useQuery({
    queryKey: ["import", jobId],
    queryFn: () => commands.importStatus(jobId ?? ""),
    enabled: jobId !== null,
    // Keep asking when the window is in the background: an import goes on there.
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      !query.state.data || query.state.data.state === "running" ? 250 : false,
    retry: false,
  });
  const running = jobId !== null && (status.data === undefined || status.data.state === "running");
  const finished = status.data && status.data.state !== "running" ? status.data : null;

  // What the import changed is read again once it is over.
  const refreshed = useRef(false);
  useEffect(() => {
    if (finished && !refreshed.current) {
      refreshed.current = true;
      void refreshSchema(connectionId);
      void refreshData(connectionId);
    }
  }, [finished, connectionId]);
  // Closing the dialog while it imports stops it, and nothing is kept.
  const live = useRef({ jobId, running });
  useEffect(() => {
    live.current = { jobId, running };
  });
  useEffect(
    () => () => {
      const { jobId: id, running: busy } = live.current;
      if (id && busy) void commands.cancelImport(id);
    },
    [],
  );

  async function choose() {
    try {
      const chosen = await pickDataFile("Import a file");
      if (!chosen) return;
      setPath(chosen);
      setMapEdits({});
      setColumnEdits({});
      setForm((f) => ({
        ...f,
        ...guessFormat(chosen),
        newTable: f.newTable || tableNameOf(chosen),
      }));
    } catch (error) {
      setStartError(error);
    }
  }

  async function start() {
    if (!path || !shown || !ready) return;
    setStarting(true);
    setStartError(null);
    try {
      const request = toRequest(path, form, seed.schema, table ?? "", mapping, columns);
      const approved = await approve({
        title: `Import ${path.slice(path.lastIndexOf("/") + 1)} into ${seed.schema}.${targetName} on ${connectionName}?`,
        lines: [
          form.intoExisting
            ? `${form.truncate ? "Empty the table, then add" : "Add"} the rows of the file to ${seed.schema}.${targetName}`
            : `Create ${seed.schema}.${targetName} and add the rows of the file`,
        ],
        reason: `import a file into ${targetName} on ${connectionName}`,
      });
      if (!approved) return;
      setJobId(await commands.startImport(connectionId, request));
    } catch (error) {
      setStartError(error);
    } finally {
      setStarting(false);
    }
  }

  const progress = status.data ? progressOf(status.data) : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {table ? `Import into ${table}` : "Import a file as a new table"}
          </DialogTitle>
          <DialogDescription>
            CSV, TSV or JSON. It is written in one transaction: if it fails, nothing is kept.
          </DialogDescription>
        </DialogHeader>

        {jobId === null ? (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => void choose()}>
                Choose file…
              </Button>
              <span
                className={cn("min-w-0 flex-1 truncate text-xs", !path && "text-muted-foreground")}
                title={path ?? undefined}
              >
                {path ?? "Nothing chosen yet"}
              </span>
            </div>

            {path && (
              <div className="flex flex-wrap items-end gap-3 text-xs">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="import-format">Format</Label>
                  <select
                    id="import-format"
                    className={SELECT}
                    value={form.format}
                    onChange={(e) => set({ format: e.target.value as "csv" | "json" })}
                  >
                    <option value="csv">CSV</option>
                    <option value="json">JSON</option>
                  </select>
                </div>
                {form.format === "csv" && (
                  <>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="import-delimiter">Delimiter</Label>
                      <select
                        id="import-delimiter"
                        className={SELECT}
                        value={form.delimiter}
                        onChange={(e) => set({ delimiter: e.target.value })}
                      >
                        {DELIMITERS.map((d) => (
                          <option key={d.value} value={d.value}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <label className="flex items-center gap-1.5 pb-1">
                      <input
                        type="checkbox"
                        checked={form.header}
                        onChange={(e) => set({ header: e.target.checked })}
                      />
                      First row has the column names
                    </label>
                    <div className="flex flex-col gap-1">
                      <Label htmlFor="import-null">NULL is written as</Label>
                      <Input
                        id="import-null"
                        className="h-7 w-28 text-xs"
                        value={form.nullText}
                        onChange={(e) => set({ nullText: e.target.value })}
                        placeholder="An empty field"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  </>
                )}
              </div>
            )}

            {preview.isError && <Failure error={preview.error} />}
            {preview.isFetching && !shown && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" /> Reading the file…
              </p>
            )}

            {shown && (
              <>
                <fieldset className="flex flex-col gap-2 text-sm">
                  <legend className="mb-1 text-sm font-medium">Into</legend>
                  {table && (
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="import-target"
                        checked={form.intoExisting}
                        onChange={() => set({ intoExisting: true })}
                      />
                      The table <span className="font-mono">{table}</span>
                    </label>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="import-target"
                      checked={!form.intoExisting}
                      onChange={() => set({ intoExisting: false })}
                    />
                    A new table
                    {!form.intoExisting && (
                      <Input
                        aria-label="New table name"
                        className="h-7 w-48 text-xs"
                        value={form.newTable}
                        onChange={(e) => set({ newTable: e.target.value })}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    )}
                  </label>
                  {form.intoExisting && (
                    <label className="flex items-start gap-2 pl-6 text-xs">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={form.truncate}
                        onChange={(e) => set({ truncate: e.target.checked })}
                      />
                      <span>
                        Empty the table first
                        <span className="block text-muted-foreground">
                          In the same transaction: if the import fails, the old rows stay.
                        </span>
                      </span>
                    </label>
                  )}
                </fieldset>

                <div className="overflow-auto rounded-md border">
                  <table className="w-full border-separate border-spacing-0 text-xs">
                    <thead className="sticky top-0 bg-background">
                      <tr>
                        <th className="border-b px-2 py-1.5 text-left font-medium">File column</th>
                        <th className="border-b px-2 py-1.5 text-left font-medium text-muted-foreground">
                          First value
                        </th>
                        <th className="border-b px-2 py-1.5 text-left font-medium">
                          {form.intoExisting ? "Goes to" : "Column and type"}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {shown.columns.map((source, i) => (
                        <tr key={source}>
                          <td className="px-2 py-1 font-mono">{source}</td>
                          <td
                            className="max-w-48 truncate px-2 py-1 text-muted-foreground"
                            title={shown.rows[0]?.[i] ?? ""}
                          >
                            {shown.rows[0]?.[i] ?? "NULL"}
                          </td>
                          <td className="px-2 py-1">
                            {form.intoExisting ? (
                              <select
                                aria-label={`Column for ${source}`}
                                className={SELECT}
                                value={mapping[source] ?? ""}
                                onChange={(e) =>
                                  setMapEdits((m) => ({ ...m, [source]: e.target.value || null }))
                                }
                              >
                                <option value="">Skip this column</option>
                                {tableColumns.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <span className="flex gap-1.5">
                                <Input
                                  aria-label={`Name for ${source}`}
                                  className="h-7 w-36 text-xs"
                                  value={columns[i]?.name ?? ""}
                                  onChange={(e) =>
                                    setColumnEdits((c) => ({
                                      ...c,
                                      [i]: { ...c[i], name: e.target.value },
                                    }))
                                  }
                                  autoComplete="off"
                                  spellCheck={false}
                                />
                                <Input
                                  aria-label={`Type for ${source}`}
                                  className="h-7 w-32 text-xs"
                                  value={columns[i]?.typeName ?? ""}
                                  onChange={(e) =>
                                    setColumnEdits((c) => ({
                                      ...c,
                                      [i]: { ...c[i], typeName: e.target.value },
                                    }))
                                  }
                                  autoComplete="off"
                                  spellCheck={false}
                                />
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Preview: the first {shown.rows.length} rows
                    {shown.moreRows && " (there are more)"}
                  </summary>
                  <div className="mt-2 max-h-48 overflow-auto rounded-md border">
                    <table className="w-full border-separate border-spacing-0">
                      <thead className="sticky top-0 bg-background">
                        <tr>
                          {shown.columns.map((c) => (
                            <th key={c} className="border-b px-2 py-1 text-left font-medium">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {shown.rows.map((row, r) => (
                          <tr key={r}>
                            {row.map((cell, i) => (
                              <td
                                key={i}
                                className={cn(
                                  "max-w-40 truncate px-2 py-0.5 font-mono",
                                  cell === null && "text-muted-foreground italic",
                                )}
                              >
                                {cell ?? "NULL"}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>

                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={form.skipBadRows}
                    onChange={(e) => set({ skipBadRows: e.target.checked })}
                  />
                  <span>
                    Skip rows that can't be written
                    <span className="block text-muted-foreground">
                      They are listed with their line. Without this the first one stops the import.
                    </span>
                  </span>
                </label>

                {mustType && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="import-type">
                      This connection is marked red and the table is emptied. Type{" "}
                      <span className="font-mono">{targetName}</span> to confirm.
                    </Label>
                    <Input
                      id="import-type"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                )}
                {problem && (
                  <p role="alert" className="text-xs font-medium text-destructive">
                    {problem}
                  </p>
                )}
              </>
            )}
            {startError !== null && <Failure error={startError} />}
          </div>
        ) : (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)}
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width]"
                style={{ width: `${(progress?.fraction ?? 0) * 100}%` }}
              />
            </div>
            <p className="flex items-center gap-2 text-sm">
              {running && <Loader2Icon className="size-4 animate-spin" />}
              {finished?.state === "done" && (
                <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
              )}
              <span>
                {finished?.state === "done" &&
                  `Done · ${Math.round(finished.rowsWritten ?? 0).toLocaleString("en-US")} rows written${
                    (finished.rowsSkipped ?? 0) > 0
                      ? `, ${Math.round(finished.rowsSkipped ?? 0).toLocaleString("en-US")} skipped`
                      : ""
                  } · `}
                {finished?.state === "cancelled" && "Cancelled, nothing was kept · "}
                {finished?.state === "failed" && "Stopped, nothing was kept · "}
                {progress?.text ?? "Starting…"}
              </span>
            </p>
            {finished?.state === "failed" && finished.error && <Failure error={finished.error} />}
            {status.data && status.data.errors.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <TriangleAlertIcon className="size-3.5 text-amber-600" />
                  {finished?.state === "done" ? "Rows that were left out" : "The row that failed"}
                </p>
                <ul className="max-h-48 overflow-auto rounded-md border p-2 font-mono text-xs select-text">
                  {status.data.errors.map((e, i) => (
                    <li key={i}>
                      <span className="text-muted-foreground">{e.at}:</span> {e.message}
                    </li>
                  ))}
                  {status.data.moreErrors && <li className="text-muted-foreground">… and more</li>}
                </ul>
                <button
                  type="button"
                  className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(errorsText(status.data))
                      .catch(() => undefined)
                  }
                >
                  Copy the list
                </button>
              </div>
            )}
            {status.isError && <Failure error={status.error} />}
          </div>
        )}

        <DialogFooter>
          {jobId === null ? (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" disabled={!ready} onClick={() => void start()}>
                {starting ? "Starting…" : "Import"}
              </Button>
            </>
          ) : running ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => jobId && void commands.cancelImport(jobId)}
            >
              Cancel import
            </Button>
          ) : (
            <Button type="button" onClick={onClose}>
              Close
            </Button>
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
