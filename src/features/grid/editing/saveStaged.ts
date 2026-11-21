import { useChangesStore } from "@/features/grid/editing/changeStore";
import { EMPTY_CHANGES, toTableChanges } from "@/features/grid/editing/changes";
import { refreshData } from "@/features/grid/useTableData";
import { commands } from "@/lib/ipc";
import type { TableTab } from "@/stores/tabs";

/**
 * Write everything staged for a tab in one transaction. The rows are read again first and only
 * then is the staged copy dropped, so the grid never flashes the old values. If the write fails
 * nothing was written and the staged edits stay, so they can be fixed and tried again.
 */
export async function saveStaged(connectionId: string, tab: TableTab) {
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
}
