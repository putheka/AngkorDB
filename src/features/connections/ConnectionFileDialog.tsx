import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import type { ConnectionConfig, SharedConnection } from "@/bindings";
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
import {
  asksFor,
  defaultFileName,
  entriesOf,
  noSecrets,
  type Secrets,
} from "@/features/connections/connectionFile";
import { connectionsKey } from "@/features/connections/useConnections";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { pickConnectionFile, pickSavePath } from "@/lib/pickFile";

interface Props {
  mode: "export" | "import";
  connections: ConnectionConfig[];
  onClose: () => void;
}

/** Write connections to a file (no secrets), or read a file and say which to add. */
export function ConnectionFileDialog({ mode, connections, onClose }: Props) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [working, setWorking] = useState(false);

  // Export: which saved connections. Import: which of the file's, and their secrets.
  const [ticked, setTicked] = useState<Set<number>>(() => new Set(connections.map((_, i) => i)));
  const [file, setFile] = useState<{ path: string; items: SharedConnection[] } | null>(null);
  const [secrets, setSecrets] = useState<Map<number, Secrets>>(new Map());
  const [done, setDone] = useState<string | null>(null);

  const toggle = (index: number, on: boolean) =>
    setTicked((now) => {
      const next = new Set(now);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });

  async function exportNow() {
    setWorking(true);
    setError(null);
    try {
      const path = await pickSavePath("Export connections", defaultFileName(new Date()), "json");
      if (!path) return;
      const ids = connections.filter((_, i) => ticked.has(i)).map((c) => c.id);
      const count = await commands.exportConnections(ids, path);
      setDone(`Exported ${count} ${count === 1 ? "connection" : "connections"} to ${path}`);
    } catch (e) {
      setError(e);
    } finally {
      setWorking(false);
    }
  }

  async function chooseFile() {
    setError(null);
    try {
      const path = await pickConnectionFile("Import connections");
      if (!path) return;
      const items = await commands.readConnectionFile(path);
      setFile({ path, items });
      setTicked(new Set(items.map((_, i) => i)));
      setSecrets(new Map());
    } catch (e) {
      setError(e);
    }
  }

  async function importNow() {
    if (!file) return;
    setWorking(true);
    setError(null);
    try {
      const saved = await commands.importConnections(
        file.path,
        entriesOf(file.items.length, ticked, secrets),
      );
      await queryClient.invalidateQueries({ queryKey: connectionsKey });
      setSecrets(new Map()); // what was typed is not kept
      setDone(`Imported ${saved.length} ${saved.length === 1 ? "connection" : "connections"}`);
    } catch (e) {
      setError(e);
      await queryClient.invalidateQueries({ queryKey: connectionsKey });
    } finally {
      setWorking(false);
    }
  }

  function typed(index: number, patch: Partial<Secrets>) {
    setSecrets((now) => new Map(now).set(index, { ...(now.get(index) ?? noSecrets), ...patch }));
  }

  const list =
    mode === "export"
      ? connections.map((c) => ({ name: c.name, detail: `${c.user}@${c.host}` }))
      : (file?.items ?? []).map((c) => ({
          name: c.name,
          detail: `${c.user}@${c.host}:${c.port}/${c.database}`,
        }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {mode === "export" ? "Export connections" : "Import connections"}
          </DialogTitle>
          <DialogDescription>
            {mode === "export"
              ? "The settings of the connections you choose, to open on another Mac. Passwords are never in the file."
              : "Add connections from a file. It has no passwords: type them here, or the first connect asks."}
          </DialogDescription>
        </DialogHeader>

        {done === null && (
          <div className="flex flex-col gap-3">
            {mode === "import" && (
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={() => void chooseFile()}>
                  Choose file…
                </Button>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                  title={file?.path}
                >
                  {file?.path ?? "Nothing chosen yet"}
                </span>
              </div>
            )}
            {list.length > 0 && (
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                {list.map((item, index) => {
                  const asks =
                    mode === "import" && file ? asksFor(file.items[index] as SharedConnection) : [];
                  return (
                    <li
                      key={index}
                      className="flex flex-col gap-1.5 rounded px-1 py-1 hover:bg-muted/40"
                    >
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={ticked.has(index)}
                          onChange={(e) => toggle(index, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        </span>
                      </label>
                      {mode === "import" && ticked.has(index) && asks.length > 0 && (
                        <div className="flex flex-wrap gap-2 pl-6">
                          {file?.items[index]?.needsPassword && (
                            <Input
                              type="password"
                              aria-label={`Password for ${item.name}`}
                              className="h-7 w-40 text-xs"
                              placeholder="Password"
                              autoComplete="new-password"
                              value={secrets.get(index)?.password ?? ""}
                              onChange={(e) => typed(index, { password: e.target.value })}
                            />
                          )}
                          {file?.items[index]?.needsSshSecret && (
                            <Input
                              type="password"
                              aria-label={`SSH secret for ${item.name}`}
                              className="h-7 w-40 text-xs"
                              placeholder={
                                asks.includes("SSH password") ? "SSH password" : "Key passphrase"
                              }
                              autoComplete="new-password"
                              value={secrets.get(index)?.sshSecret ?? ""}
                              onChange={(e) => typed(index, { sshSecret: e.target.value })}
                            />
                          )}
                          {file?.items[index]?.needsSslKeySecret && (
                            <Input
                              type="password"
                              aria-label={`TLS key passphrase for ${item.name}`}
                              className="h-7 w-40 text-xs"
                              placeholder="TLS key passphrase"
                              autoComplete="new-password"
                              value={secrets.get(index)?.sslKeySecret ?? ""}
                              onChange={(e) => typed(index, { sslKeySecret: e.target.value })}
                            />
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {mode === "import" && file && (
              <p className="text-xs text-muted-foreground">
                Paths of key and certificate files are copied as they are: check them on this Mac.
              </p>
            )}
          </div>
        )}
        {done !== null && (
          <p className="flex items-start gap-2 text-sm">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span className="min-w-0 break-all">{done}</span>
          </p>
        )}
        {error !== null && (
          <div role="alert" className="text-xs">
            <p className="font-medium text-destructive">{errorMessage(error)}</p>
            {errorDetails(error).map((line) => (
              <p key={line} className="text-muted-foreground">
                {line}
              </p>
            ))}
          </div>
        )}

        <DialogFooter>
          {done !== null ? (
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={working || ticked.size === 0 || (mode === "import" && !file)}
                onClick={() => void (mode === "export" ? exportNow() : importNow())}
              >
                {working ? "Working…" : mode === "export" ? "Export…" : "Import"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
