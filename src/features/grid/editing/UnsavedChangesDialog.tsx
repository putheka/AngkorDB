import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { describePending } from "@/features/grid/editing/changes";
import { describeDirty } from "@/features/grid/editing/unsaved";
import {
  discardAll,
  saveAll,
  useUnsavedGuard,
  type UnsavedRequest,
} from "@/features/grid/editing/unsavedGuard";
import { errorDetails, errorMessage } from "@/lib/errors";

/**
 * "Commit changes before you …?" Commit writes them (one table after another, asking first if the
 * connection's safe mode says so), Discard throws them away, Cancel and Esc stay where you are.
 * If saving fails the dialog stays, with the reason, and the edits are still staged.
 */
export function UnsavedChangesDialog() {
  const request = useUnsavedGuard((s) => s.request);
  const answer = useUnsavedGuard((s) => s.answer);
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => !open && answer(false)}>
      <AlertDialogContent>
        {/* Keyed by the request, so each asking starts with no leftover error. */}
        {request && <Body key={request.tabs.map((t) => t.tab.id).join()} request={request} />}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function Body({ request }: { request: UnsavedRequest }) {
  const answer = useUnsavedGuard((s) => s.answer);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (await saveAll(request)) answer(true);
      else setSaving(false); // the safe mode's question was answered no
    } catch (e) {
      setError(e);
      setSaving(false);
    }
  };

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>Commit changes before you {request.verb}?</AlertDialogTitle>
        <AlertDialogDescription>
          {request.tabs.length === 1
            ? "This table has changes that are not saved yet."
            : `${request.tabs.length} tables have changes that are not saved yet.`}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <ul className="max-h-48 list-disc space-y-1 overflow-y-auto rounded-md border bg-muted/30 py-2 pr-3 pl-6 text-xs">
        {request.tabs.map((dirty) => (
          <li key={dirty.tab.id}>
            <span className="font-mono">
              {dirty.tab.schema}.{dirty.tab.name}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {describeDirty(dirty, describePending)}
            </span>
          </li>
        ))}
      </ul>
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
      <AlertDialogFooter>
        <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
        <Button
          variant="destructive"
          disabled={saving}
          onClick={() => {
            discardAll(request);
            answer(true);
          }}
        >
          Discard
        </Button>
        <Button disabled={saving} onClick={() => void save()}>
          {saving ? "Committing…" : "Commit"}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
