import { useMutation } from "@tanstack/react-query";

import { saveStaged } from "@/features/grid/editing/saveStaged";
import type { TableTab } from "@/stores/tabs";

/** Save the staged edits of a tab (see `saveStaged`), as a mutation the table view can watch. */
export function useCommitChanges(connectionId: string, tab: TableTab, onSaved: () => void) {
  return useMutation({
    mutationFn: () => saveStaged(connectionId, tab),
    // On the mutation itself, so it still runs when a new edit resets the observer.
    onSuccess: onSaved,
  });
}
