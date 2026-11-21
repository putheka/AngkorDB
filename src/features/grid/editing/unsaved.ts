import { useChangesStore } from "@/features/grid/editing/changeStore";
import { summarize, type PendingSummary } from "@/features/grid/editing/changes";
import { useTabsStore, type TableTab } from "@/stores/tabs";

/** A table tab that has edits waiting to be saved. */
export interface DirtyTab {
  tab: TableTab;
  summary: PendingSummary;
}

/** The tabs with staged edits, in tab order; `only` limits it to some tabs. */
export function dirtyTabs(only?: readonly string[]): DirtyTab[] {
  const { byTab } = useChangesStore.getState();
  return useTabsStore.getState().tabs.flatMap((tab) => {
    if (tab.kind !== "table" || (only && !only.includes(tab.id))) return [];
    const changes = byTab[tab.id];
    const summary = changes ? summarize(changes) : undefined;
    return summary && summary.total > 0 ? [{ tab, summary }] : [];
  });
}

/** Does this tab have edits waiting? For the dot on the tab. */
export const useIsDirty = (tabId: string) =>
  useChangesStore((s) => {
    const changes = s.byTab[tabId];
    return changes !== undefined && summarize(changes).total > 0;
  });

/** How many tabs have edits waiting. */
export const useUnsavedTabCount = () =>
  useChangesStore((s) => Object.values(s.byTab).filter((c) => summarize(c).total > 0).length);

// Typing into a preview tab (the italic one the next single click replaces) makes it a real
// tab: otherwise opening another table would swallow the edits.
useChangesStore.subscribe((state) => {
  const { tabs, pin } = useTabsStore.getState();
  for (const tab of tabs) {
    const changes = state.byTab[tab.id];
    if (tab.preview && changes && summarize(changes).total > 0) pin(tab.id);
  }
});
