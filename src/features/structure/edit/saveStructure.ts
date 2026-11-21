import { toChanges } from "@/features/structure/edit/structureEdits";
import { useStructureEditStore } from "@/features/structure/edit/structureEditStore";
import { EMPTY_EDITS } from "@/features/structure/edit/structureEdits";
import { refreshData } from "@/features/grid/useTableData";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import type { TableTab } from "@/stores/tabs";

/**
 * Save the structure changes staged for a tab. If the save fails the staged changes stay, so they
 * can be fixed and tried again. If the transaction went through but a `CONCURRENTLY` statement
 * after it failed, the changes are cleared (what ran is saved) and a notice says what did not.
 * Returns that notice's message, or `null` when everything ran.
 */
export async function saveStructureStaged(
  connectionId: string,
  tab: TableTab,
): Promise<string | null> {
  const store = useStructureEditStore.getState();
  const staged = store.byTab[tab.id] ?? EMPTY_EDITS;
  const result = await commands.applyStructureChanges(
    connectionId,
    tab.schema,
    tab.name,
    toChanges(staged),
  );

  // The table now looks different: the Structure view, the sidebar, the grid's columns and rows.
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["schema", connectionId] }),
    refreshData(connectionId),
  ]);
  store.discard(tab.id);

  if (result.failedConcurrent) {
    const failed = result.failedConcurrent;
    const message = `The other changes were saved, but "${failed.label}" failed: ${errorMessage(failed.error)}`;
    store.setNotice(tab.id, { message, sql: failed.sql });
    return message;
  }
  store.setNotice(tab.id, null);
  return null;
}
