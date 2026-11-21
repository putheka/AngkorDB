import type { ObjectOperation } from "@/bindings";
import { refreshData } from "@/features/grid/useTableData";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { useBrowserStore } from "@/stores/browser";
import { tableTabId, useTabsStore } from "@/stores/tabs";

/**
 * Run an operation, then make the app agree with the database: the sidebar and everything under
 * "schema" is read again, and the tab of a table that was renamed or dropped is closed (a
 * renamed one is opened again under its new name).
 */
export async function runObjectOperation(
  connectionId: string,
  operation: ObjectOperation,
): Promise<void> {
  await commands.applyObjectOperation(connectionId, operation);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["schema", connectionId] }),
    refreshData(connectionId),
  ]);

  const tabs = useTabsStore.getState();
  if (operation.kind === "rename" || operation.kind === "drop") {
    const id = tableTabId(operation.schema, operation.name);
    const wasOpen = tabs.tabs.some((t) => t.id === id);
    if (wasOpen) tabs.close(id);
    if (operation.kind === "rename" && wasOpen) {
      tabs.openTable(
        { schema: operation.schema, name: operation.newName, kind: operation.objectKind },
        true,
      );
    }
  } else if (operation.kind === "renameSchema" || operation.kind === "dropSchema") {
    // Tabs of what was in it point at names that are gone.
    for (const tab of tabs.tabs) {
      if (tab.kind === "table" && tab.schema === operation.name) tabs.close(tab.id);
    }
    if (operation.kind === "renameSchema") useBrowserStore.getState().setSchema(operation.newName);
  } else if (operation.kind === "createSchema") {
    useBrowserStore.getState().setSchema(operation.name);
  } else if (operation.kind === "createTable") {
    tabs.openTable({ schema: operation.schema, name: operation.name, kind: "table" }, true);
  }
}
