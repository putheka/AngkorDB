import { useQueryViews } from "@/features/query/queryViews";
import { useTabsStore } from "@/stores/tabs";

/** Open a saved query in a new query tab. */
export function openSavedQuery(sql: string) {
  useTabsStore.getState().newQuery();
  const tabId = useTabsStore.getState().activeId;
  if (tabId) {
    useQueryViews
      .getState()
      .update(tabId, { text: sql, selection: { anchor: sql.length, head: sql.length } });
  }
}
