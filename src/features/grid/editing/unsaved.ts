import { useChangesStore } from "@/features/grid/editing/changeStore";
import { summarize, type PendingSummary } from "@/features/grid/editing/changes";
import {
  describeEdits,
  editCount,
  type StructureEdits,
} from "@/features/structure/edit/structureEdits";
import { useStructureEditStore } from "@/features/structure/edit/structureEditStore";
import { useTabsStore, type TableTab } from "@/stores/tabs";

/** A table tab that has edits waiting to be saved. */
export interface DirtyTab {
  tab: TableTab;
  /** Staged edits of the rows (all zero if there are none). */
  summary: PendingSummary;
  /** Staged changes to the structure of the table, if any. */
  structure: StructureEdits | null;
}

/** "2 edits in 1 row · 1 column added": everything waiting in a tab. */
export function describeDirty(
  dirty: DirtyTab,
  describeRows: (s: PendingSummary) => string,
): string {
  const parts = [
    dirty.summary.total > 0 ? describeRows(dirty.summary) : "",
    dirty.structure ? describeEdits(dirty.structure) : "",
  ];
  return parts.filter((p) => p !== "").join(" · ");
}

/** The tabs with staged edits, in tab order; `only` limits it to some tabs. */
export function dirtyTabs(only?: readonly string[]): DirtyTab[] {
  const { byTab } = useChangesStore.getState();
  const structure = useStructureEditStore.getState().byTab;
  return useTabsStore.getState().tabs.flatMap((tab) => {
    if (tab.kind !== "table" || (only && !only.includes(tab.id))) return [];
    const changes = byTab[tab.id];
    const summary = changes
      ? summarize(changes)
      : { cells: 0, rows: 0, inserts: 0, deletes: 0, total: 0 };
    const staged = structure[tab.id];
    const structureEdits = staged && editCount(staged) > 0 ? staged : null;
    return summary.total > 0 || structureEdits ? [{ tab, summary, structure: structureEdits }] : [];
  });
}

/** Does this tab have edits waiting? For the dot on the tab. */
export const useIsDirty = (tabId: string) => {
  const rows = useChangesStore((s) => {
    const changes = s.byTab[tabId];
    return changes !== undefined && summarize(changes).total > 0;
  });
  const structure = useStructureEditStore((s) => {
    const staged = s.byTab[tabId];
    return staged !== undefined && editCount(staged) > 0;
  });
  return rows || structure;
};

/** How many tabs have edits waiting. */
export function useUnsavedTabCount() {
  const rows = useChangesStore((s) => s.byTab);
  const structure = useStructureEditStore((s) => s.byTab);
  const ids = new Set<string>();
  for (const [id, changes] of Object.entries(rows)) if (summarize(changes).total > 0) ids.add(id);
  for (const [id, staged] of Object.entries(structure)) if (editCount(staged) > 0) ids.add(id);
  return ids.size;
}

// Typing into a preview tab (the italic one the next single click replaces) makes it a real
// tab: otherwise opening another table would swallow the edits.
useChangesStore.subscribe((state) => {
  const { tabs, pin } = useTabsStore.getState();
  for (const tab of tabs) {
    const changes = state.byTab[tab.id];
    if (tab.preview && changes && summarize(changes).total > 0) pin(tab.id);
  }
});
useStructureEditStore.subscribe((state) => {
  const { tabs, pin } = useTabsStore.getState();
  for (const tab of tabs) {
    const staged = state.byTab[tab.id];
    if (tab.preview && staged && editCount(staged) > 0) pin(tab.id);
  }
});
