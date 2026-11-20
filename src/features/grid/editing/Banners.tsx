import { LockIcon, PencilIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { describePending, type PendingSummary } from "@/features/grid/editing/changes";
import { errorDetails, errorMessage } from "@/lib/errors";

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

interface PendingBarProps {
  summary: PendingSummary;
  /** Writing right now. */
  committing: boolean;
  /** Why the last commit failed; nothing was written. */
  error: unknown;
  onPreview: () => void;
  onCommit: () => void;
  onDiscard: () => void;
}

/** Edits waiting to be written, with Preview SQL, Commit and Discard (ANG-23). */
export function PendingBar({
  summary,
  committing,
  error,
  onPreview,
  onCommit,
  onDiscard,
}: PendingBarProps) {
  const failed = error !== null && error !== undefined;
  return (
    <div className="shrink-0 border-b bg-yellow-400/10 text-xs">
      <div role="status" className="flex items-center gap-2 px-3 py-1">
        <PencilIcon className="size-3.5 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <span className="tabular-nums">{describePending(summary)} not saved yet</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={committing} onClick={onPreview}>
            Preview SQL
            <kbd className="ml-1 text-[10px] opacity-60">⇧⌘P</kbd>
          </Button>
          <Button size="xs" variant="ghost" disabled={committing} onClick={onDiscard}>
            Discard
            <kbd className="ml-1 text-[10px] opacity-60">⇧⌘⌫</kbd>
          </Button>
          <Button size="xs" disabled={committing} onClick={onCommit}>
            {committing ? "Saving…" : "Commit"}
            <kbd className="ml-1 text-[10px] opacity-70">⌘S</kbd>
          </Button>
        </div>
      </div>
      {failed && (
        <div role="alert" className="border-t border-destructive/20 bg-destructive/10 px-3 py-1.5">
          <p className="font-medium text-destructive">{errorMessage(error)}</p>
          {errorDetails(error).map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
