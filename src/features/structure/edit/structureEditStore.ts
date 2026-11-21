import { create } from "zustand";

import { omit } from "@/lib/omit";

import {
  EMPTY_EDITS,
  editCount,
  type StructureEdits,
} from "@/features/structure/edit/structureEdits";
import { useTabsStore } from "@/stores/tabs";

/** A `CONCURRENTLY` statement that failed after the rest of a save had gone through. */
export interface SaveNotice {
  message: string;
  sql: string;
}

interface StructureEditState {
  /** The staged structure changes of each table tab. */
  byTab: Record<string, StructureEdits>;
  /** What to tell the person about the last save of a tab, until they close it. */
  notices: Record<string, SaveNotice>;
  update: (tabId: string, change: (edits: StructureEdits) => StructureEdits) => void;
  discard: (tabId: string) => void;
  setNotice: (tabId: string, notice: SaveNotice | null) => void;
}

/** Structure changes staged in the Structure view, not saved yet (ANG-37). */
export const useStructureEditStore = create<StructureEditState>()((set) => ({
  byTab: {},
  notices: {},
  update: (tabId, change) =>
    set((state) => {
      const next = change(state.byTab[tabId] ?? EMPTY_EDITS);
      return {
        byTab: editCount(next) === 0 ? omit(state.byTab, tabId) : { ...state.byTab, [tabId]: next },
      };
    }),
  discard: (tabId) => set((state) => ({ byTab: omit(state.byTab, tabId) })),
  setNotice: (tabId, notice) =>
    set((state) => ({
      notices: notice ? { ...state.notices, [tabId]: notice } : omit(state.notices, tabId),
    })),
}));

/** The staged changes of one tab. */
export const useTabStructureEdits = (tabId: string) =>
  useStructureEditStore((s) => s.byTab[tabId] ?? EMPTY_EDITS);

/** How many structure changes a tab has staged. */
export const stagedStructureCount = (tabId: string) =>
  editCount(useStructureEditStore.getState().byTab[tabId] ?? EMPTY_EDITS);

// A closed tab takes its staged changes and notice with it.
useTabsStore.subscribe((state) => {
  const open = new Set(state.tabs.map((t) => t.id));
  const { byTab, notices } = useStructureEditStore.getState();
  const gone = [...Object.keys(byTab), ...Object.keys(notices)].filter((id) => !open.has(id));
  if (gone.length === 0) return;
  useStructureEditStore.setState({
    byTab: Object.fromEntries(Object.entries(byTab).filter(([id]) => open.has(id))),
    notices: Object.fromEntries(Object.entries(notices).filter(([id]) => open.has(id))),
  });
});

let counter = 0;
/** A number for something staged (a new column, index or constraint), so it can be found again. */
export const nextEditId = () => ++counter;
