import { AlertTriangleIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { SaveNotice } from "@/features/structure/edit/structureEditStore";
import { errorDetails, errorMessage } from "@/lib/errors";

interface Props {
  summary: string;
  problems: string[];
  saving: boolean;
  error: unknown;
  onPreview: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** "3 changes staged": preview the SQL, save, or throw them away. */
export function StructurePendingBar({
  summary,
  problems,
  saving,
  error,
  onPreview,
  onSave,
  onDiscard,
}: Props) {
  return (
    <div className="shrink-0 border-b bg-amber-500/10 px-3 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Not saved yet:</span>
        <span>{summary}</span>
        <div className="ml-auto flex gap-1.5">
          <Button size="xs" variant="outline" onClick={onPreview}>
            Preview SQL
          </Button>
          <Button size="xs" onClick={onSave} disabled={saving || problems.length > 0}>
            {saving ? "Saving…" : "Save (⌘S)"}
          </Button>
          <Button size="xs" variant="ghost" onClick={onDiscard} disabled={saving}>
            Discard
          </Button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul role="status" className="mt-1 list-disc pl-5 text-amber-800 dark:text-amber-300">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error !== null && (
        <div role="alert" className="mt-1">
          <p className="font-medium text-destructive">{errorMessage(error)}</p>
          {errorDetails(error).map((line) => (
            <p key={line} className="text-muted-foreground">
              {line}
            </p>
          ))}
          <p className="text-muted-foreground">Nothing was saved. The changes are still staged.</p>
        </div>
      )}
    </div>
  );
}

/** A save that went through only in part: what did not run. */
export function SaveNoticeBar({
  notice,
  onDismiss,
}: {
  notice: SaveNotice;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b bg-destructive/10 px-3 py-1.5 text-xs"
    >
      <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-destructive">{notice.message}</p>
        <p className="font-mono break-all text-muted-foreground">{notice.sql}</p>
        <p className="text-muted-foreground">
          A failed CONCURRENTLY index can leave an invalid index behind: look under Indexes.
        </p>
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}
