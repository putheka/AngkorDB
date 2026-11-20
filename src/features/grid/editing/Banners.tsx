import { LockIcon, PencilIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/** Why this table can't be edited. */
export function ReadOnlyBanner({ reason }: { reason: string }) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <LockIcon className="size-3.5 shrink-0" />
      <span>Read-only. {reason}</span>
    </div>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Edits waiting to be written. Applying them comes with the pending-changes engine (ANG-23). */
export function PendingBar({
  cells,
  rows,
  onDiscard,
}: {
  cells: number;
  rows: number;
  onDiscard: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b bg-yellow-400/10 px-3 py-1 text-xs"
    >
      <PencilIcon className="size-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
      <span className="tabular-nums">
        {plural(cells, "edit")} in {plural(rows, "row")} not saved yet
      </span>
      <Button size="xs" variant="ghost" className="ml-auto" onClick={onDiscard}>
        Discard
      </Button>
    </div>
  );
}
