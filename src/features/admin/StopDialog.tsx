import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import type { Backend } from "@/bindings";
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
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

export type StopAction = "cancel" | "terminate";

interface Props {
  connectionId: string;
  backend: Backend;
  action: StopAction;
  /** `gone`: it had finished before the signal arrived. */
  onDone: (result: { gone: boolean }) => void;
  onClose: () => void;
}

/** Cancel the query of a connection, or close the connection: what it does, then the go-ahead. */
export function StopDialog({ connectionId, backend, action, onDone, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const color = connections.find((c) => c.id === connectionId)?.color ?? "none";

  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const terminate = action === "terminate";
  const pid = String(backend.pid);
  const sql = terminate
    ? `SELECT pg_terminate_backend(${pid});`
    : `SELECT pg_cancel_backend(${pid});`;
  const mustType = needsTypedConfirmation(color, terminate);
  const ready = !mustType || confirmationMatches(typed, pid);
  const inTransaction = (backend.state ?? "").startsWith("idle in transaction");

  const run = async () => {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `${terminate ? "Close" : "Cancel"} process ${pid} on ${connectionName}?`,
        lines: [sql],
        reason: `${terminate ? "close" : "cancel"} process ${pid} on ${connectionName}`,
      });
      if (!approved) return;
      const sent = terminate
        ? await commands.terminateBackend(connectionId, backend.pid)
        : await commands.cancelBackend(connectionId, backend.pid);
      onDone({ gone: !sent });
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
            <DialogTitle>
              {terminate ? `Close connection ${pid}?` : `Cancel the query of ${pid}?`}
            </DialogTitle>
            <DialogDescription>
              {terminate
                ? "The connection is closed. Whatever it was doing stops, and its open transaction is rolled back."
                : "The query it is running is stopped. The connection stays open."}
            </DialogDescription>
          </DialogHeader>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">User</dt>
            <dd>{backend.user ?? "—"}</dd>
            <dt className="text-muted-foreground">Application</dt>
            <dd>{backend.application || "—"}</dd>
            <dt className="text-muted-foreground">State</dt>
            <dd>{backend.state ?? "—"}</dd>
          </dl>
          {backend.query !== "" && (
            <pre
              aria-label="Query"
              className="max-h-32 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap select-text"
            >
              <SqlText code={backend.query} />
            </pre>
          )}

          {terminate && inTransaction && (
            <p
              role="status"
              className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>Everything this transaction changed and did not commit is lost.</span>
            </p>
          )}

          <pre
            aria-label="SQL"
            className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs select-text"
          >
            <SqlText code={sql} />
          </pre>

          {mustType && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="type-pid">
                This connection is marked red. Type <span className="font-mono">{pid}</span> to
                confirm.
              </Label>
              <Input
                id="type-pid"
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
              Keep it
            </Button>
            <Button
              type="submit"
              variant={terminate ? "destructive" : "default"}
              disabled={!ready || running}
            >
              {running ? "Working…" : terminate ? "Close connection" : "Cancel query"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
