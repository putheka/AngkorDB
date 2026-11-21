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
import { useSchemas } from "@/features/sidebar/useSchema";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

const ME = "@me";

export type SchemaMode = "create" | "rename" | "drop";

interface Props {
  connectionId: string;
  mode: SchemaMode;
  /** The schema being browsed: the one rename and drop start on. */
  current: string | null;
  onClose: () => void;
}

/** Create, rename or drop a schema (drop with the CASCADE option). */
export function SchemaDialog({ connectionId, mode, current, onClose }: Props) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const { data: connections = [] } = useConnections();
  const color = connections.find((c) => c.id === connectionId)?.color ?? "none";
  const schemas = useSchemas(connectionId);
  const options = useQuery({
    queryKey: ["schema", connectionId, "database-options"],
    queryFn: () => commands.databaseOptions(connectionId),
    enabled: mode === "create",
  });

  const existing = (schemas.data ?? []).map((s) => s.name);
  const [target, setTarget] = useState(current ?? "");
  const [name, setName] = useState("");
  const [owner, setOwner] = useState(ME);
  const [cascade, setCascade] = useState(false);
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const chosen = existing.includes(target) ? target : (existing[0] ?? "");
  const operation: ObjectOperation =
    mode === "create"
      ? { kind: "createSchema", name: name.trim(), owner: owner === ME ? null : owner }
      : mode === "rename"
        ? { kind: "renameSchema", name: chosen, newName: name.trim() }
        : { kind: "dropSchema", name: chosen, cascade };

  const enabled =
    mode === "drop" ? chosen !== "" : name.trim() !== "" && (mode === "create" || chosen !== "");
  const preview = useQuery({
    queryKey: ["object-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewObjectOperation(connectionId, operation),
    enabled,
    retry: false,
  });

  const mustType = needsTypedConfirmation(color, mode === "drop");
  const ready = !!preview.data && (!mustType || confirmationMatches(typed, chosen));
  const title =
    mode === "create" ? "New schema" : mode === "rename" ? "Rename a schema" : "Drop a schema";
  const verb = mode === "create" ? "Create" : mode === "rename" ? "Rename" : "Drop";

  const run = async () => {
    if (!ready || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `${verb} the schema ${mode === "create" ? name.trim() : chosen} on ${connectionName}?`,
        lines: preview.data?.statements.map((s) => s.sql) ?? [],
        reason: `${verb.toLowerCase()} a schema on ${connectionName}`,
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
      <DialogContent
        className="sm:max-w-lg"
        onOpenAutoFocus={(e) => {
          // The first field is the schema picker; the name is what is typed.
          if (mode === "rename") {
            e.preventDefault();
            document.getElementById("schema-name")?.focus();
          }
        }}
      >
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
              {mode === "drop"
                ? "The schema and what is in it is deleted."
                : mode === "rename"
                  ? "Everything in it comes along."
                  : "A place for tables, views and functions."}
            </DialogDescription>
          </DialogHeader>

          {mode !== "create" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schema-target">Schema</Label>
              <Select value={chosen} onValueChange={setTarget}>
                <SelectTrigger id="schema-target" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {existing.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {mode !== "drop" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schema-name">{mode === "create" ? "Name" : "New name"}</Label>
              <Input
                id="schema-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          {mode === "create" && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="schema-owner">Owner</Label>
              <Select value={owner} onValueChange={setOwner}>
                <SelectTrigger id="schema-owner" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ME}>
                    Me{options.data ? ` (${options.data.currentRole})` : ""}
                  </SelectItem>
                  {(options.data?.roles ?? []).map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {mode === "drop" && (
            <>
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
                    Also drop every table, view and function in it. Without it, PostgreSQL refuses
                    when the schema is not empty.
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
              <Label htmlFor="schema-type-name">
                This connection is marked red. Type <span className="font-mono">{chosen}</span> to
                confirm.
              </Label>
              <Input
                id="schema-type-name"
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
              {running ? `${verb}…` : verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
