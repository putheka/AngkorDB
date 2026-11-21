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
import { runObjectOperation } from "@/features/objects/runObjectOperation";
import { SqlText } from "@/features/query/SqlText";
import { useWriteApproval } from "@/features/safety/approval";
import { errorDetails, errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

/** The settings and current value of a sequence, and a way to set it (`setval`). */
export function SequenceDialog({
  connectionId,
  object,
  onClose,
}: {
  connectionId: string;
  object: DbObject;
  onClose: () => void;
}) {
  const { name: connectionName, approve } = useWriteApproval(connectionId);
  const info = useQuery({
    queryKey: ["schema", connectionId, "sequence", object.schema, object.name],
    queryFn: () => commands.sequenceInfo(connectionId, object.schema, object.name),
  });
  const [value, setValue] = useState("");
  const [isCalled, setIsCalled] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const trimmed = value.trim();
  const valid = /^-?\d+$/.test(trimmed);
  const operation = useMemo<ObjectOperation>(
    () => ({
      kind: "setSequence",
      schema: object.schema,
      name: object.name,
      value: trimmed,
      isCalled,
    }),
    [object, trimmed, isCalled],
  );
  const preview = useQuery({
    queryKey: ["object-preview", connectionId, JSON.stringify(operation)],
    queryFn: () => commands.previewObjectOperation(connectionId, operation),
    enabled: valid,
    retry: false,
  });

  const run = async () => {
    if (!preview.data || running) return;
    setRunning(true);
    setError(null);
    try {
      const approved = await approve({
        title: `Set ${object.schema}.${object.name} on ${connectionName}?`,
        lines: preview.data.statements.map((s) => s.sql),
        reason: `set the sequence ${object.name} on ${connectionName}`,
      });
      if (!approved) return;
      await runObjectOperation(connectionId, operation);
      setValue("");
    } catch (e) {
      setError(e);
    } finally {
      setRunning(false);
    }
  };

  const data = info.data;
  const rows: [string, string][] = data
    ? [
        ["Type", data.dataType],
        ["Current value", data.lastValue ?? "not used yet"],
        ["Starts at", data.start],
        ["Increment", data.increment],
        ["Range", `${data.min} to ${data.max}`],
        ["Cache", data.cache],
        ["Cycles", data.cycle ? "yes" : "no"],
        ["Owned by", data.ownedBy ?? "nothing"],
      ]
    : [];
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
            <DialogTitle>Sequence {object.name}</DialogTitle>
            <DialogDescription>
              {object.schema}.{object.name}
            </DialogDescription>
          </DialogHeader>

          {info.isError && (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorMessage(info.error)}
            </p>
          )}
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm select-text">
            {rows.map(([label, text]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono break-all">{text}</dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-col gap-1.5 border-t pt-3">
            <Label htmlFor="sequence-value">Set it to</Label>
            <Input
              id="sequence-value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="a whole number"
              className="font-mono"
              inputMode="numeric"
            />
            <div
              role="radiogroup"
              aria-label="What the value means"
              className="flex flex-col gap-1 text-sm"
            >
              <label className="flex items-center gap-2">
                <input type="radio" checked={!isCalled} onChange={() => setIsCalled(false)} />
                The next value is {valid ? trimmed : "this number"}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={isCalled} onChange={() => setIsCalled(true)} />
                {valid ? trimmed : "This number"} was already used: the next one is after it
              </label>
            </div>
            <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              Setting it at or below a value that is in a table makes the next insert fail with a
              duplicate key.
            </p>
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
              {running ? "Setting…" : "Set value"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
