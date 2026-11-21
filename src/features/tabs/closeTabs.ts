import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";

/**
 * Close tabs, asking first if any of them has staged edits (ANG-29). Every way of closing a tab
 * goes through here: the × button, middle click, ⌘W, the tab menu.
 */
async function closeAfterAsking(ids: string[], close: () => void) {
  if (ids.length === 0) return;
  const verb = ids.length === 1 ? "close this tab" : "close these tabs";
  const connectionId = useSessionStore.getState().activeConnectionId;
  if (await guardUnsaved(connectionId, verb, ids)) close();
}

const allIds = () => useTabsStore.getState().tabs.map((t) => t.id);

export const closeTab = (id: string) =>
  closeAfterAsking([id], () => useTabsStore.getState().close(id));

export const closeOtherTabs = (id: string) =>
  closeAfterAsking(
    allIds().filter((other) => other !== id),
    () => useTabsStore.getState().closeOthers(id),
  );

export function closeTabsToTheRight(id: string) {
  const ids = allIds();
  return closeAfterAsking(ids.slice(ids.indexOf(id) + 1), () =>
    useTabsStore.getState().closeToRight(id),
  );
}

export const closeAllTabs = () =>
  closeAfterAsking(allIds(), () => useTabsStore.getState().closeAll());
