import { useQuery } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  FORMATS,
  backupProblem,
  databaseNameOf,
  defaultBackupForm,
  defaultFileName,
  defaultRestoreForm,
  extensionOf,
  progressText,
  restoreProblem,
  toBackupRequest,
  toRestoreRequest,
  toolsAdvice,
  type BackupForm,
  type RestoreForm,
} from "@/features/backup/backupOptions";
import { useConnections } from "@/features/connections/useConnections";
import { confirmationMatches, needsTypedConfirmation } from "@/features/objects/createTable";
import { useWriteApproval } from "@/features/safety/approval";
import { refreshSchema, useDatabases } from "@/features/sidebar/useSchema";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { pickBackup, pickFolder, pickSavePath } from "@/lib/pickFile";
import { cn } from "@/lib/utils";
import { readToolsDir, useBackupDialog, writeToolsDir } from "@/stores/backupDialog";
import { useSessionStore } from "@/stores/session";

const SELECT = "h-8 rounded-lg border bg-background px-2 text-sm";

/** Back the open database up, or restore a backup, with the programs of this Mac. */
export function BackupDialog({ connectionId }: { connectionId: string }) {
  const { open, mode: firstMode, close } = useBackupDialog();
  if (!open) return null;
  return <Body key={firstMode} connectionId={connectionId} firstMode={firstMode} onClose={close} />;
}

function Body({
  connectionId,
  firstMode,
  onClose,
}: {
  connectionId: string;
  firstMode: "backup" | "restore";
  onClose: () => void;
}) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const connection = connections.find((c) => c.id === connectionId);
  const serverVersion = useSessionStore((s) => s.serverVersion);
  const databases = useDatabases(connectionId);
  const database = connection?.database ?? "";

  const [mode, setMode] = useState(firstMode);
  const [toolsDir, setToolsDir] = useState<string | null>(readToolsDir);
  const [backupForm, setBackupForm] = useState<BackupForm>(defaultBackupForm);
  const [restoreForm, setRestoreForm] = useState<RestoreForm>(defaultRestoreForm);
  const [path, setPath] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);

  const found = useQuery({
    queryKey: ["pg-tools", toolsDir],
    queryFn: () => commands.detectPgTools(toolsDir),
    staleTime: 60_000,
  });
  const advice = toolsAdvice(found.data ?? [], serverVersion);

  const status = useQuery({
    queryKey: ["tool", jobId],
    queryFn: () => commands.toolStatus(jobId ?? ""),
    enabled: jobId !== null,
    refetchIntervalInBackground: true,
    refetchInterval: (query) =>
      !query.state.data || query.state.data.state === "running" ? 300 : false,
    retry: false,
  });
  const running = jobId !== null && (status.data === undefined || status.data.state === "running");
  const finished = status.data && status.data.state !== "running" ? status.data : null;

  const live = useRef({ jobId, running });
  useEffect(() => {
    live.current = { jobId, running };
  });
  useEffect(
    () => () => {
      const { jobId: id, running: busy } = live.current;
      if (id && busy) void commands.cancelTool(id);
    },
    [],
  );
  const logEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logEnd.current?.scrollIntoView?.({ block: "end" });
  }, [status.data?.lines]);
  useEffect(() => {
    if (finished?.state === "done") void refreshSchema(connectionId);
  }, [finished?.state, connectionId]);

  const color = connection?.color ?? "none";
  const dropping = mode === "restore" && !restoreForm.intoNew && restoreForm.clean;
  const targetName = restoreForm.intoNew ? restoreForm.newName.trim() : restoreForm.existing;
  const mustType = needsTypedConfirmation(color, dropping);
  const problem = mode === "backup" ? backupProblem(backupForm) : restoreProblem(restoreForm);
  const ready =
    !!path &&
    !problem &&
    !!advice.tool &&
    !advice.warning &&
    (!mustType || confirmationMatches(typed, targetName)) &&
    !starting;

  async function chooseFolder() {
    try {
      const chosen = await pickFolder("Folder with pg_dump and pg_restore");
      if (!chosen) return;
      writeToolsDir(chosen);
      setToolsDir(chosen);
    } catch (error) {
      setStartError(error);
    }
  }

  async function choose() {
    try {
      if (mode === "backup") {
        const chosen = await pickSavePath(
          "Back up",
          defaultFileName(database, backupForm.format, new Date()),
          extensionOf(backupForm.format) || "backup",
        );
        if (chosen) setPath(chosen);
      } else {
        // A directory backup is a folder; ask for a file first, the folder button is next to it.
        const chosen = await pickBackup("Choose a backup", false);
        if (chosen) pickedRestore(chosen);
      }
    } catch (error) {
      setStartError(error);
    }
  }

  function pickedRestore(chosen: string) {
    setPath(chosen);
    setRestoreForm((f) => ({ ...f, newName: f.newName || databaseNameOf(chosen) }));
  }

  async function chooseBackupFolder() {
    try {
      const chosen = await pickBackup("Choose a directory backup", true);
      if (chosen) pickedRestore(chosen);
    } catch (error) {
      setStartError(error);
    }
  }

  async function start() {
    if (!path || !ready) return;
    setStarting(true);
    setStartError(null);
    try {
      if (mode === "backup") {
        setJobId(
          await commands.startBackup(
            connectionId,
            toBackupRequest(backupForm, path, toolsDir, null),
          ),
        );
      } else {
        const approved = await approve({
          title: `Restore ${path.slice(path.lastIndexOf("/") + 1)} into ${targetName} on ${connectionName}?`,
          lines: [
            restoreForm.intoNew
              ? `Create the database ${targetName} and restore the backup into it`
              : `Restore the backup into ${targetName}${restoreForm.clean ? ", dropping what is in the backup first" : ""}`,
          ],
          reason: `restore a backup into ${targetName} on ${connectionName}`,
        });
        if (!approved) return;
        setJobId(
          await commands.startRestore(connectionId, toRestoreRequest(restoreForm, path, toolsDir)),
        );
      }
    } catch (error) {
      setStartError(error);
    } finally {
      setStarting(false);
    }
  }

  const setBackup = (patch: Partial<BackupForm>) => setBackupForm((f) => ({ ...f, ...patch }));
  const setRestore = (patch: Partial<RestoreForm>) => setRestoreForm((f) => ({ ...f, ...patch }));
  const format = FORMATS.find((f) => f.value === backupForm.format);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Back up and restore</DialogTitle>
          <DialogDescription>
            Uses <span className="font-mono">pg_dump</span> and{" "}
            <span className="font-mono">pg_restore</span> from this Mac. The password is passed in
            the environment, never on a command line.
          </DialogDescription>
        </DialogHeader>

        {jobId === null ? (
          <div className="flex flex-col gap-4">
            <div role="tablist" className="flex self-start rounded-md border p-0.5 text-xs">
              {(["backup", "restore"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => {
                    setMode(m);
                    setPath(null);
                  }}
                  className={cn(
                    "rounded px-3 py-1 font-medium",
                    mode === m ? "bg-muted text-foreground" : "text-muted-foreground",
                  )}
                >
                  {m === "backup" ? "Back up" : "Restore"}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1 rounded-md border px-3 py-2 text-xs">
              {found.isPending ? (
                <p className="text-muted-foreground">Looking for pg_dump…</p>
              ) : advice.tool && !advice.warning ? (
                <p>
                  pg_dump {advice.tool.version}{" "}
                  <span className="text-muted-foreground">
                    · {advice.tool.source} · {advice.tool.dir}
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  {advice.warning}
                </p>
              )}
              <p className="flex items-center gap-2 text-muted-foreground">
                <button
                  type="button"
                  className="underline-offset-2 hover:text-foreground hover:underline"
                  onClick={() => void chooseFolder()}
                >
                  Choose another folder…
                </button>
                {toolsDir && (
                  <button
                    type="button"
                    className="underline-offset-2 hover:text-foreground hover:underline"
                    onClick={() => {
                      writeToolsDir(null);
                      setToolsDir(null);
                    }}
                  >
                    Use the ones found
                  </button>
                )}
              </p>
            </div>

            {mode === "backup" ? (
              <div className="flex flex-col gap-3">
                <p className="text-sm">
                  Back up <span className="font-mono">{database}</span>
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="backup-format">Format</Label>
                    <select
                      id="backup-format"
                      className={SELECT}
                      value={backupForm.format}
                      onChange={(e) => {
                        setPath(null);
                        setBackup({ format: e.target.value as BackupForm["format"] });
                      }}
                    >
                      {FORMATS.map((f) => (
                        <option key={f.value} value={f.value}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">{format?.hint}</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="backup-scope">What</Label>
                    <select
                      id="backup-scope"
                      className={SELECT}
                      value={backupForm.scope}
                      onChange={(e) => setBackup({ scope: e.target.value as BackupForm["scope"] })}
                    >
                      <option value="everything">Schema and data</option>
                      <option value="schema">Schema only</option>
                      <option value="data">Data only</option>
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="backup-include">Only these tables</Label>
                    <textarea
                      id="backup-include"
                      className="h-16 rounded-lg border bg-background px-2 py-1 font-mono text-xs"
                      value={backupForm.include}
                      onChange={(e) => setBackup({ include: e.target.value })}
                      placeholder="All of them. Names or patterns: public.orders*"
                      spellCheck={false}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="backup-exclude">Leave these tables out</Label>
                    <textarea
                      id="backup-exclude"
                      className="h-16 rounded-lg border bg-background px-2 py-1 font-mono text-xs"
                      value={backupForm.exclude}
                      onChange={(e) => setBackup({ exclude: e.target.value })}
                      placeholder="None"
                      spellCheck={false}
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  {(backupForm.format === "custom" || backupForm.format === "directory") && (
                    <label className="flex items-center gap-2">
                      Compression
                      <Input
                        aria-label="Compression"
                        className="h-7 w-16 text-xs"
                        value={backupForm.compression}
                        onChange={(e) => setBackup({ compression: e.target.value })}
                        placeholder="Default"
                        inputMode="numeric"
                      />
                    </label>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={backupForm.noOwner}
                      onChange={(e) => setBackup({ noOwner: e.target.checked })}
                    />
                    Leave out who owns what
                  </label>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" onClick={() => void choose()}>
                    Choose backup file…
                  </Button>
                  <Button type="button" variant="outline" onClick={() => void chooseBackupFolder()}>
                    Choose directory backup…
                  </Button>
                </div>
                <fieldset className="flex flex-col gap-2 text-sm">
                  <legend className="mb-1 font-medium">Restore into</legend>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="restore-target"
                      checked={restoreForm.intoNew}
                      onChange={() => setRestore({ intoNew: true })}
                    />
                    A new database
                    {restoreForm.intoNew && (
                      <Input
                        aria-label="New database name"
                        className="h-7 w-56 text-xs"
                        value={restoreForm.newName}
                        onChange={(e) => setRestore({ newName: e.target.value })}
                        autoComplete="off"
                        spellCheck={false}
                      />
                    )}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="restore-target"
                      checked={!restoreForm.intoNew}
                      onChange={() => setRestore({ intoNew: false })}
                    />
                    A database that exists
                    {!restoreForm.intoNew && (
                      <select
                        aria-label="Database"
                        className={cn(SELECT, "h-7 text-xs")}
                        value={restoreForm.existing}
                        onChange={(e) => setRestore({ existing: e.target.value })}
                      >
                        <option value="">Choose…</option>
                        {(databases.data ?? []).map((d) => (
                          <option key={d.name} value={d.name}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </label>
                </fieldset>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  {!restoreForm.intoNew && (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={restoreForm.clean}
                        onChange={(e) => setRestore({ clean: e.target.checked })}
                      />
                      <span>
                        Drop what is in the backup first
                        <span className="block text-xs text-muted-foreground">
                          Tables, views and the rest are dropped and made again.
                        </span>
                      </span>
                    </label>
                  )}
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={restoreForm.noOwner}
                      onChange={(e) => setRestore({ noOwner: e.target.checked })}
                    />
                    Don't set who owns what
                  </label>
                  <label className="flex items-center gap-2">
                    Parallel jobs
                    <Input
                      aria-label="Parallel jobs"
                      className="h-7 w-14 text-xs"
                      value={restoreForm.jobs}
                      onChange={(e) => setRestore({ jobs: e.target.value })}
                      inputMode="numeric"
                    />
                  </label>
                </div>
                {mustType && (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="restore-type">
                      This connection is marked red and the database is changed. Type{" "}
                      <span className="font-mono">{targetName}</span> to confirm.
                    </Label>
                    <Input
                      id="restore-type"
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              {mode === "backup" && (
                <Button type="button" variant="outline" onClick={() => void choose()}>
                  Save as…
                </Button>
              )}
              <span
                className={cn("min-w-0 flex-1 truncate text-xs", !path && "text-muted-foreground")}
                title={path ?? undefined}
              >
                {path ?? (mode === "backup" ? "Nothing chosen yet" : "No backup chosen yet")}
              </span>
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
            <p className="flex items-center gap-2 text-sm">
              {running && <Loader2Icon className="size-4 animate-spin" />}
              {finished?.state === "done" && (
                <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
              )}
              <span>
                {finished?.state === "done" && "Done · "}
                {finished?.state === "cancelled" && "Cancelled · "}
                {finished?.state === "failed" && "Stopped · "}
                {status.data ? progressText(status.data, mode === "backup") : "Starting…"}
              </span>
            </p>
            {status.data?.command && (
              <p
                className="truncate font-mono text-xs text-muted-foreground"
                title={status.data.command}
              >
                {status.data.command}
              </p>
            )}
            <pre
              aria-label="Output"
              className="h-56 overflow-auto rounded-md border bg-muted/30 p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap select-text"
            >
              {(status.data?.log ?? []).join("\n")}
              <div ref={logEnd} />
            </pre>
            {finished?.state === "done" && status.data?.output && (
              <p className="text-xs">
                {mode === "backup" ? "Saved to" : "Restored into"}{" "}
                <span className="font-mono select-text">{status.data.output}</span>
              </p>
            )}
            {finished?.state === "cancelled" && (
              <p className="text-xs text-muted-foreground">
                {mode === "backup"
                  ? "The unfinished file was removed."
                  : "A database made for the restore was dropped again."}
              </p>
            )}
            {finished?.state === "failed" && finished.error && <Failure error={finished.error} />}
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
                {starting ? "Starting…" : mode === "backup" ? "Back up" : "Restore"}
              </Button>
            </>
          ) : running ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => jobId && void commands.cancelTool(jobId)}
            >
              Cancel
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
      <p className="font-medium whitespace-pre-wrap text-destructive">{errorMessage(error)}</p>
      {errorDetails(error).map((line) => (
        <p key={line} className="text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}
