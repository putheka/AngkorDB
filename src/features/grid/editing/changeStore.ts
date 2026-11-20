import { create } from "zustand";

import { EMPTY_CHANGES, type ChangeSet } from "@/features/grid/editing/changes";
import { omit } from "@/lib/omit";
import { useTabsStore } from "@/stores/tabs";

interface ChangesState {
  byTab: Record<string, ChangeSet>;
  /** Replace a tab's staged changes with what `update` makes of them. */
  change: (tabId: string, update: (changes: ChangeSet) => ChangeSet) => void;
  /** Throw away everything staged for a tab. */
  discard: (tabId: string) => void;
}

export const useChangesStore = create<ChangesState>()((set) => ({
  byTab: {},
  change: (tabId, update) =>
    set((state) => ({
      byTab: { ...state.byTab, [tabId]: update(state.byTab[tabId] ?? EMPTY_CHANGES) },
    })),
  discard: (tabId) => set((state) => ({ byTab: omit(state.byTab, tabId) })),
}));

/** The changes staged for a table tab. */
export function useTabChanges(tabId: string): ChangeSet {
  return useChangesStore((s) => s.byTab[tabId] ?? EMPTY_CHANGES);
}

// Closing a tab drops what was staged in it. (ANG-29 asks first, once there is something to lose.)
useTabsStore.subscribe((state) => {
  const open = new Set(state.tabs.map((t) => t.id));
  const { byTab } = useChangesStore.getState();
  if (Object.keys(byTab).every((id) => open.has(id))) return;
  useChangesStore.setState({
    byTab: Object.fromEntries(Object.entries(byTab).filter(([id]) => open.has(id))),
  });
});
