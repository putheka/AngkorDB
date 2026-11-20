import { useQuery } from "@tanstack/react-query";

import type { TableChanges } from "@/bindings";
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

interface PreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  schema: string;
  table: string;
  changes: TableChanges;
  committing: boolean;
  onCommit: () => void;
}

/**
 * The SQL that Commit would run, values written in so it can be read. What actually runs
 * binds the values as parameters; this text is only for looking at.
 */
export function PreviewDialog({
  open,
  onOpenChange,
  connectionId,
  schema,
  table,
  changes,
  committing,
  onCommit,
}: PreviewDialogProps) {
  const preview = useQuery({
    queryKey: ["preview", connectionId, schema, table, changes],
    queryFn: () => commands.previewChanges(connectionId, schema, table, changes),
    enabled: open,
    gcTime: 0,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-3xl"
        onCloseAutoFocus={(e) => {
          // Back to the grid, so the keyboard keeps working where the user left off.
          const grid = document.querySelector<HTMLElement>(
            'canvas[data-testid="data-grid-canvas"]',
          );
          if (grid) {
            e.preventDefault();
            grid.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Preview SQL</DialogTitle>
          <DialogDescription>
            Runs as one transaction: if any statement fails, nothing is saved.
          </DialogDescription>
        </DialogHeader>
        {preview.isPending ? (
          <p className="py-6 text-center text-muted-foreground">Preparing…</p>
        ) : preview.isError ? (
          <p role="alert" className="text-destructive">
            {errorMessage(preview.error)}
          </p>
        ) : (
          <pre
            aria-label="Generated SQL"
            className="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-relaxed break-all whitespace-pre-wrap select-text"
          >
            <SqlText code={preview.data} />
          </pre>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button disabled={!preview.data || committing} onClick={onCommit}>
            {committing ? "Saving…" : "Commit"}
            <kbd className="ml-1 text-[10px] opacity-70">⌘S</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
