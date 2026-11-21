import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { DbObject, ObjectOperation } from "@/bindings";
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
import { confirmationMatches, needsTypedConfirmation } from "@/features/objects/createTable";
import { runObjectOperation } from "@/features/objects/runObjectOperation";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

export type ObjectAction = "rename" | "truncate" | "drop";

const KIND_WORDS: Partial<Record<DbObject["kind"], string>> = {
  table: "table",
  partitionedTable: "table",
  foreignTable: "foreign table",
  view: "view",
  materializedView: "materialized view",
};

interface Props {
  connectionId: string;
  action: ObjectAction;
  object: DbObject;
  onClose: () => void;
}

/**
 * Rename, truncate or drop one table or view: the options, the SQL it will run, and (on a red
 * connection) the name to type before something is thrown away.
 */
export function ObjectActionDialog({ connectionId, action, object, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const color = connections.find((c) => c.id === connectionId)?.color ?? "none";

  const [newName, setNewName] = useState(object.name);
  const [restartIdentity, setRestartIdentity] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const word = KIND_WORDS[object.kind] ?? "object";
  const destructive = action !== "rename";
  const mustType = needsTypedConfirmation(color, destructive);

  const operation = useMemo<ObjectOperation>(() => {
    const target = { schema: object.schema, name: object.name };
    if (action === "rename") {
      return { kind: "rename", ...target, objectKind: object.kind, newName: newName.trim() };
    }
    if (action === "truncate") return { kind: "truncate", ...target, restartIdentity, cascade };
    return { kind: "drop", ...target, objectKind: object.kind, cascade };
  }, [action, object, newName, restartIdentity, cascade]);

  const preview = useQuery({
    queryKey: ["object-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewObjectOperation(connectionId, operation),
    retry: false,
  });

  const ready = !!preview.data && (!mustType || confirmationMatches(typed, object.name));
  const title =
    action === "rename"
      ? `Rename ${object.name}`
      : action === "truncate"
        ? `Empty ${object.name}?`
        : `Drop ${object.name}?`;
  const verb = action === "rename" ? "Rename" : action === "truncate" ? "Truncate" : "Drop";

  const run = async () => {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `${verb} ${object.schema}.${object.name} on ${connectionName}?`,
        lines: preview.data?.statements.map((s) => s.sql) ?? [],
        reason: `${verb.toLowerCase()} ${object.name} on ${connectionName}`,
      });
      if (!approved) return;
      await runObjectOperation(connectionId, operation);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {object.schema}.{object.name} is a {word}.
              {action === "truncate" && " Every row is deleted at once; the table stays."}
              {action === "drop" && ` The ${word} and everything in it is deleted.`}
            </DialogDescription>
          </DialogHeader>

          {action === "rename" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-name">New name</Label>
              <Input
                id="new-name"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
          )}
          {action === "truncate" && (
            <>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={restartIdentity}
                  onChange={(e) => setRestartIdentity(e.target.checked)}
                />
                <span>
                  Restart identity
                  <span className="block text-xs text-muted-foreground">
                    The sequences of its identity and serial columns start again at 1.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={cascade}
                  onChange={(e) => setCascade(e.target.checked)}
                />
                <span>
                  Cascade
                  <span className="block text-xs text-muted-foreground">
                    Also empty the tables that have a foreign key to this one. Without it,
                    PostgreSQL refuses when there are any.
                  </span>
                </span>
              </label>
            </>
          )}
          {action === "drop" && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
              />
              <span>
                Cascade
                <span className="block text-xs text-muted-foreground">
                  Also drop what depends on it: views, and the foreign keys of other tables. Without
                  it, PostgreSQL refuses when something does.
                </span>
              </span>
            </label>
          )}

          {destructive && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>This can't be undone: the data is gone for good.</span>
            </p>
          )}

          {preview.isError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {errorMessage(preview.error)}
            </p>
          )}
          {preview.data && (
            <pre
              aria-label="SQL"
              className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed select-text"
            >
              <SqlText code={preview.data.sql} />
            </pre>
          )}

          {mustType && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="type-name">
                This connection is marked red. Type <span className="font-mono">{object.name}</span>{" "}
                to confirm.
              </Label>
              <Input
                id="type-name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
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
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={destructive ? "destructive" : "default"}
              disabled={!ready || running}
            >
              {running ? `${verb}…` : verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
