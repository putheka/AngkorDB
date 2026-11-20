import { useMutation } from "@tanstack/react-query";

import { useChangesStore } from "@/features/grid/editing/changeStore";
import { EMPTY_CHANGES, toTableChanges } from "@/features/grid/editing/changes";
import { refreshData } from "@/features/grid/useTableData";
import { commands } from "@/lib/ipc";
import type { TableTab } from "@/stores/tabs";

/**
 * Write everything staged for a tab in one transaction. On success the rows are read again
 * first and only then is the staged copy dropped, so the grid never flashes the old values.
 * On failure nothing was written and the staged edits stay, so they can be fixed and retried.
 */
export function useCommitChanges(connectionId: string, tab: TableTab, onSaved: () => void) {
  return useMutation({
    mutationFn: async () => {
      // Read at the last moment: ⌘S may have just closed a cell editor.
      const staged = useChangesStore.getState().byTab[tab.id] ?? EMPTY_CHANGES;
      const result = await commands.applyChanges(
        connectionId,
        tab.schema,
        tab.name,
        toTableChanges(staged),
      );
      await refreshData(connectionId);
      useChangesStore.getState().discard(tab.id);
      return result;
    },
    // On the mutation itself, so it still runs when a new edit resets the observer.
    onSuccess: onSaved,
  });
}
