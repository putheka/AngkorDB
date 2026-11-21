import { useQuery } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { runObjectOperation } from "@/features/objects/runObjectOperation";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

const END = "@end";

/** The values of an enum type, and a way to add one (`ALTER TYPE … ADD VALUE`). */
export function EnumDialog({
  connectionId,
  object,
  onClose,
}: {
  connectionId: string;
  object: DbObject;
  onClose: () => void;
}) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const values = useQuery({
    queryKey: ["schema", connectionId, "enum", object.oid],
    queryFn: () => commands.listEnumValues(connectionId, object.oid),
  });
  const [value, setValue] = useState("");
  const [position, setPosition] = useState(END);
  const [before, setBefore] = useState(false);
  const [ifNotExists, setIfNotExists] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const operation = useMemo<ObjectOperation>(
    () => ({
      kind: "addEnumValue",
      schema: object.schema,
      name: object.name,
      value,
      position: position === END ? null : { before, existing: position },
      ifNotExists,
    }),
    [object, value, position, before, ifNotExists],
  );
  const preview = useQuery({
    queryKey: ["object-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewObjectOperation(connectionId, operation),
    enabled: value !== "",
    retry: false,
  });

  const run = async () => {
    if (!preview.data || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `Add a value to ${object.schema}.${object.name} on ${connectionName}?`,
        lines: preview.data.statements.map((s) => s.sql),
        reason: `add a value to ${object.name} on ${connectionName}`,
      });
      if (!approved) return;
      await runObjectOperation(connectionId, operation);
      await values.refetch();
      setValue("");
      setPosition(END);
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
            <DialogTitle>Enum {object.name}</DialogTitle>
            <DialogDescription>
              {object.schema}.{object.name}: the values in their order. A value can be added but not
              removed or renamed here.
            </DialogDescription>
          </DialogHeader>

          <ol aria-label="Values" className="flex flex-wrap gap-1.5 text-sm">
            {(values.data ?? []).map((v) => (
              <li key={v} className="rounded-md border px-2 py-0.5 font-mono">
                {v}
              </li>
            ))}
            {values.data?.length === 0 && <li className="text-muted-foreground">No values.</li>}
          </ol>

          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label htmlFor="enum-value">New value</Label>
            <Input
              id="enum-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="retired"
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enum-position">Place it</Label>
                <Select value={position} onValueChange={setPosition}>
                  <SelectTrigger id="enum-position" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={END}>At the end</SelectItem>
                    {(values.data ?? []).map((v) => (
                      <SelectItem key={v} value={v}>
                        Next to {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="enum-side">…on which side</Label>
                <Select
                  value={before ? "before" : "after"}
                  onValueChange={(v) => setBefore(v === "before")}
                  disabled={position === END}
                >
                  <SelectTrigger id="enum-side" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="before">Before it</SelectItem>
                    <SelectItem value="after">After it</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={ifNotExists}
                onChange={(e) => setIfNotExists(e.target.checked)}
              />
              Skip it if it is there already
            </label>
          </div>

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
              Close
            </Button>
            <Button type="submit" disabled={!preview.data || running}>
              {running ? "Adding…" : "Add value"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
