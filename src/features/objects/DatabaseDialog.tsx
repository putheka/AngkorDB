import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import type { ObjectOperation } from "@/bindings";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnections } from "@/features/connections/useConnections";
import { confirmationMatches, needsTypedConfirmation } from "@/features/objects/createTable";
import { runObjectOperation } from "@/features/objects/runObjectOperation";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { useDatabases } from "@/features/sidebar/useSchema";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

const DEFAULT = "@default";

function Pick({
  id,
  label,
  value,
  onChange,
  options,
  defaultLabel,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  defaultLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT}>{defaultLabel}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {o}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface Props {
  connectionId: string;
  mode: "create" | "drop";
  onClose: () => void;
}

/** A new database (owner, template, encoding), or dropping one (warning if it is in use). */
export function DatabaseDialog({ connectionId, mode, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const color = connections.find((c) => c.id === connectionId)?.color ?? "none";
  const databases = useDatabases(connectionId);
  const options = useQuery({
    queryKey: ["schema", connectionId, "database-options"],
    queryFn: () => commands.databaseOptions(connectionId),
    enabled: mode === "create",
  });

  const droppable = (databases.data ?? []).filter((d) => !d.isCurrent).map((d) => d.name);
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(DEFAULT);
  const [template, setTemplate] = useState(DEFAULT);
  const [encoding, setEncoding] = useState(DEFAULT);
  const [target, setTarget] = useState("");
  const [force, setForce] = useState(false);
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const dropName = target || droppable[0] || "";
  const operation: ObjectOperation =
    mode === "create"
      ? {
          kind: "createDatabase",
          name: name.trim(),
          owner: owner === DEFAULT ? null : owner,
          template: template === DEFAULT ? null : template,
          encoding: encoding === DEFAULT ? null : encoding,
        }
      : { kind: "dropDatabase", name: dropName, force };
  const enabled = mode === "create" ? name.trim() !== "" : dropName !== "";
  const preview = useQuery({
    queryKey: ["object-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewObjectOperation(connectionId, operation),
    enabled,
    retry: false,
  });
  const using = useQuery({
    queryKey: ["schema", connectionId, "database-connections", dropName],
    queryFn: () => commands.databaseConnections(connectionId, dropName),
    enabled: mode === "drop" && dropName !== "",
  });

  const mustType = mode === "drop" && needsTypedConfirmation(color, true);
  const ready = !!preview.data && (!mustType || confirmationMatches(typed, dropName));
  const verb = mode === "create" ? "Create" : "Drop";

  const run = async () => {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `${verb} the database ${mode === "create" ? name.trim() : dropName} on ${connectionName}?`,
        lines: preview.data?.statements.map((s) => s.sql) ?? [],
        reason: `${verb.toLowerCase()} a database on ${connectionName}`,
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
            <DialogTitle>{mode === "create" ? "New database" : "Drop a database"}</DialogTitle>
            <DialogDescription>
              {mode === "create"
                ? "It is created on the server of this connection."
                : "The database and everything in it is deleted. You can't drop the one you are in."}
            </DialogDescription>
          </DialogHeader>

          {mode === "create" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="db-name">Name</Label>
                <Input
                  id="db-name"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="shop_staging"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Pick
                  id="db-owner"
                  label="Owner"
                  value={owner}
                  onChange={setOwner}
                  options={options.data?.roles ?? []}
                  defaultLabel={`Me${options.data ? ` (${options.data.currentRole})` : ""}`}
                />
                <Pick
                  id="db-template"
                  label="Copy from (template)"
                  value={template}
                  onChange={setTemplate}
                  options={options.data?.templates ?? []}
                  defaultLabel="template1 (the default)"
                />
              </div>
              <Pick
                id="db-encoding"
                label="Encoding"
                value={encoding}
                onChange={setEncoding}
                options={options.data?.encodings ?? []}
                defaultLabel="Same as the template"
              />
              {encoding !== DEFAULT && template !== "template0" && (
                <p className="text-xs text-muted-foreground">
                  A different encoding than the template's needs template0 as the template;
                  PostgreSQL says so if it is not.
                </p>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="db-drop">Database</Label>
                <Select value={dropName} onValueChange={setTarget}>
                  <SelectTrigger id="db-drop" className="w-full">
                    <SelectValue placeholder="No other database" />
                  </SelectTrigger>
                  <SelectContent>
                    {droppable.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {(using.data ?? 0) > 0 && (
                <p
                  role="status"
                  className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                >
                  <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    {using.data} other {using.data === 1 ? "connection is" : "connections are"}{" "}
                    using it. PostgreSQL refuses to drop it unless they are disconnected.
                  </span>
                </p>
              )}
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                />
                <span>
                  Disconnect them first (WITH (FORCE))
                  <span className="block text-xs text-muted-foreground">
                    Ends the sessions of everyone using it. PostgreSQL 13 and later.
                  </span>
                </span>
              </label>
              <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                This can't be undone: the data is gone for good.
              </p>
            </>
          )}

          {preview.isError && (
            <p role="alert" className="text-xs font-medium text-destructive">
              {errorMessage(preview.error)}
            </p>
          )}
          {preview.data && (
            <pre
              aria-label="SQL"
              className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs select-text"
            >
              <SqlText code={preview.data.sql} />
            </pre>
          )}

          {mustType && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="db-type-name">
                This connection is marked red. Type <span className="font-mono">{dropName}</span> to
                confirm.
              </Label>
              <Input
                id="db-type-name"
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
              variant={mode === "drop" ? "destructive" : "default"}
              disabled={!ready || running}
            >
              {running ? `${verb}…` : mode === "create" ? "Create database" : "Drop database"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
