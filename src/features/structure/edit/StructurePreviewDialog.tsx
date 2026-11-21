import { useQuery } from "@tanstack/react-query";
import { AlertTriangleIcon } from "lucide-react";

import type { StructureChange } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SqlText } from "@/features/query/SqlText";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

interface Props {
  connectionId: string;
  schema: string;
  table: string;
  changes: StructureChange[];
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}

/** The SQL the staged changes would run, exactly as it would run. Nothing is executed here. */
export function StructurePreviewDialog({
  connectionId,
  schema,
  table,
  changes,
  saving,
  onSave,
  onClose,
}: Props) {
  const preview = useQuery({
    queryKey: ["structure-preview", connectionId, schema, table, JSON.stringify(changes)],
    queryFn: () => commands.previewStructureChanges(connectionId, schema, table, changes),
    retry: false,
  });
  const statements = preview.data?.statements ?? [];
  const destructive = statements.filter((s) => s.destructive);
  const concurrent = statements.filter((s) => s.concurrent);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            SQL for {schema}.{table}
          </DialogTitle>
          <DialogDescription>
            {preview.data
              ? `${statements.length} ${statements.length === 1 ? "statement" : "statements"}. This is what runs when you save.`
              : "Writing the statements…"}
          </DialogDescription>
        </DialogHeader>

        {preview.isError && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errorMessage(preview.error)}
          </p>
        )}
        {destructive.length > 0 && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          >
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              This throws things away for good: {destructive.map((s) => s.label).join(", ")}. A
              dropped column loses its data; the table can't get it back.
            </span>
          </p>
        )}
        {concurrent.length > 0 && (
          <p className="text-xs text-muted-foreground">
            CONCURRENTLY statements run after the transaction, on their own. If one fails the rest
            stays saved.
          </p>
        )}
        {preview.data && (
          <pre
            aria-label="SQL"
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed select-text"
          >
            <SqlText code={preview.data.sql} />
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onSave} disabled={saving || !preview.data}>
            Save (⌘S)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
