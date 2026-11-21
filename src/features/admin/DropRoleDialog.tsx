import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import type { Role, RoleOperation } from "@/bindings";
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

interface Props {
  connectionId: string;
  role: Role;
  roles: Role[];
  onClose: () => void;
}

/** Drop a role, optionally after handing what it owns to another one. */
export function DropRoleDialog({ connectionId, role, roles, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const queryClient = useQueryClient();
  const color = connections.find((c) => c.id === connectionId)?.color ?? "none";

  const [heir, setHeir] = useState("");
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const operation: RoleOperation = { kind: "drop", name: role.name, reassignTo: heir || null };
  const preview = useQuery({
    queryKey: ["role-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewRoleOperation(connectionId, operation),
    retry: false,
  });
  const mustType = needsTypedConfirmation(color, true);
  const ready = !!preview.data && !running && (!mustType || confirmationMatches(typed, role.name));

  const run = async () => {
    if (!ready || !preview.data) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `Drop role ${role.name} on ${connectionName}?`,
        lines: preview.data.statements.map((s) => s.sql),
        reason: `drop role ${role.name} on ${connectionName}`,
      });
      if (!approved) return;
      await commands.applyRoleOperation(connectionId, operation);
      await queryClient.invalidateQueries({ queryKey: ["roles", connectionId] });
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
            <DialogTitle>Drop {role.name}?</DialogTitle>
            <DialogDescription>
              The role is deleted. PostgreSQL refuses while it owns tables or has privileges in this
              database.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="heir">Give what it owns to</Label>
            <select
              id="heir"
              value={heir}
              onChange={(e) => setHeir(e.target.value)}
              className="h-8 rounded-lg border bg-background px-2 text-sm"
            >
              <option value="">Nobody: just drop it</option>
              {roles
                .filter((r) => r.name !== role.name && !r.predefined)
                .map((r) => (
                  <option key={r.name} value={r.name}>
                    {r.name}
                  </option>
                ))}
            </select>
            {heir && (
              <p className="text-xs text-muted-foreground">
                Its objects and privileges in <em>this database</em> go to {heir} and what is left
                is dropped. Other databases of the server are not touched; if the role has things
                there, the drop is refused.
              </p>
            )}
          </div>

          <p
            role="status"
            className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>This can't be undone.</span>
          </p>

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
              <Label htmlFor="type-role">
                This connection is marked red. Type <span className="font-mono">{role.name}</span>{" "}
                to confirm.
              </Label>
              <Input
                id="type-role"
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
            <Button type="submit" variant="destructive" disabled={!ready}>
              {running ? "Working…" : "Drop role"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
