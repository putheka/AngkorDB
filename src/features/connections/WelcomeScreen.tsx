import { DatabaseIcon, DownloadIcon, PlusIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { ConnectionConfig } from "@/bindings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConnectionDialog } from "@/features/connections/ConnectionDialog";
import { ConnectionFileDialog } from "@/features/connections/ConnectionFileDialog";
import { HostKeyDialog } from "@/features/connections/HostKeyDialog";
import { ConnectionRow } from "@/features/connections/ConnectionRow";
import {
  useConnections,
  useDeleteConnection,
  useDuplicateConnection,
} from "@/features/connections/useConnections";
import { ReopenSetting } from "@/features/workspace/ReopenSetting";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { useSessionStore } from "@/stores/session";
import { useWelcome } from "@/stores/welcome";

/** `null` = closed, `"new"` = create, otherwise edit that connection. */
type DialogState = null | "new" | ConnectionConfig;

interface Section {
  /** null = a single ungrouped list, no heading */
  name: string | null;
  items: ConnectionConfig[];
}

const byName = (a: ConnectionConfig, b: ConnectionConfig) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

function matches(connection: ConnectionConfig, query: string) {
  return [
    connection.name,
    connection.host,
    connection.database,
    connection.user,
    connection.group ?? "",
  ].some((value) => value.toLowerCase().includes(query));
}

function groupConnections(connections: ConnectionConfig[]): Section[] {
  const named = new Map<string, ConnectionConfig[]>();
  const ungrouped: ConnectionConfig[] = [];
  for (const connection of connections) {
    if (!connection.group) {
      ungrouped.push(connection);
      continue;
    }
    const bucket = named.get(connection.group);
    if (bucket) bucket.push(connection);
    else named.set(connection.group, [connection]);
  }

  const sections: Section[] = [...named.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([name, items]) => ({ name, items: items.sort(byName) }));
  if (ungrouped.length > 0) {
    sections.push({ name: named.size > 0 ? "Other" : null, items: ungrouped.sort(byName) });
  }
  return sections;
}

export function WelcomeScreen() {
  const { data: connections = [], isLoading, error: loadError } = useConnections();
  const duplicate = useDuplicateConnection();
  const remove = useDeleteConnection();

  const connect = useSessionStore((s) => s.connect);
  const connectingId = useSessionStore((s) => s.connectingId);
  const connectError = useSessionStore((s) => s.error);
  const clearConnectError = useSessionStore((s) => s.clearError);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [deleting, setDeleting] = useState<ConnectionConfig | null>(null);
  const [fileDialog, setFileDialog] = useState<"import" | "export" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // File ▸ New Connection (also when a connection is open: it was closed first).
  const newRequested = useWelcome((s) => s.newConnection);
  const requestDone = useWelcome((s) => s.done);
  const shownDialog: DialogState = newRequested ? "new" : dialog;

  const query = search.trim().toLowerCase();
  const sections = useMemo(
    () => groupConnections(query ? connections.filter((c) => matches(c, query)) : connections),
    [connections, query],
  );
  const groups = useMemo(
    () => [...new Set(connections.flatMap((c) => (c.group ? [c.group] : [])))].sort(),
    [connections],
  );

  const message = actionError ?? connectError ?? (loadError ? errorMessage(loadError) : null);
  const dismissMessage = () => {
    setActionError(null);
    clearConnectError();
  };

  function handleDuplicate(connection: ConnectionConfig) {
    duplicate.mutate(connection.id, {
      onSuccess: (copy) => setSelectedId(copy.id),
      onError: (e) => setActionError(errorMessage(e)),
    });
  }

  function confirmDelete() {
    const target = deleting;
    setDeleting(null);
    if (!target) return;
    remove.mutate(target.id, { onError: (e) => setActionError(errorMessage(e)) });
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col gap-4 px-6 py-8">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Connections</h1>
          <p className="text-sm text-muted-foreground">Double-click a connection to open it.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setFileDialog("import")}>
            <UploadIcon /> Import…
          </Button>
          <Button
            variant="ghost"
            disabled={connections.length === 0}
            onClick={() => setFileDialog("export")}
          >
            <DownloadIcon /> Export…
          </Button>
          <Button onClick={() => setDialog("new")}>
            <PlusIcon /> New connection
          </Button>
        </div>
      </header>

      {connections.length > 0 && (
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search connections"
            aria-label="Search connections"
            className="pl-8"
            autoComplete="off"
          />
        </div>
      )}

      {message && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p className="flex-1">{message}</p>
          <button type="button" aria-label="Dismiss" onClick={dismissMessage}>
            <XIcon className="size-4" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? null : connections.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-muted-foreground">
            <DatabaseIcon className="size-10" />
            <p className="text-sm">No connections yet.</p>
            <Button variant="outline" onClick={() => setDialog("new")}>
              Add your first connection
            </Button>
          </div>
        ) : sections.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No connections match “{search.trim()}”.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {sections.map((section) => (
              <section key={section.name ?? "all"}>
                {section.name && (
                  <h2 className="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {section.name}
                  </h2>
                )}
                <ul className="flex flex-col gap-0.5">
                  {section.items.map((connection) => (
                    <ConnectionRow
                      key={connection.id}
                      connection={connection}
                      selected={selectedId === connection.id}
                      connecting={connectingId === connection.id}
                      disabled={connectingId !== null}
                      onSelect={() => setSelectedId(connection.id)}
                      onConnect={() => void connect(connection)}
                      onConnectInNewWindow={() => void commands.openWindow(connection.id, false)}
                      onEdit={() => setDialog(connection)}
                      onDuplicate={() => handleDuplicate(connection)}
                      onDelete={() => setDeleting(connection)}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <ReopenSetting />

      <HostKeyDialog />

      {fileDialog && (
        <ConnectionFileDialog
          mode={fileDialog}
          connections={connections}
          onClose={() => setFileDialog(null)}
        />
      )}

      {shownDialog !== null && (
        <ConnectionDialog
          connection={shownDialog === "new" ? null : shownDialog}
          groups={groups}
          onClose={() => {
            setDialog(null);
            requestDone();
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the connection
              {deleting?.hasPassword ? " and its saved password from your Keychain" : ""}. The
              database itself is not touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
