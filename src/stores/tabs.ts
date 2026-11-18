import { create } from "zustand";

import type { ObjectKind } from "@/bindings";

/** A table, view or materialized view open in the main pane. Query tabs join this in ANG-13. */
export interface TableTab {
  id: string;
  kind: "table";
  schema: string;
  name: string;
  objectKind: ObjectKind;
}

interface TabsState {
  tabs: TableTab[];
  activeId: string | null;
  /** Opens a tab for the object, or brings its existing tab to the front. */
  openTable: (object: { schema: string; name: string; kind: ObjectKind }) => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeAll: () => void;
}

export const tableTabId = (schema: string, name: string) => `table:${schema}.${name}`;

export const useTabsStore = create<TabsState>()((set) => ({
  tabs: [],
  activeId: null,

  openTable: ({ schema, name, kind }) =>
    set((state) => {
      const id = tableTabId(schema, name);
      if (state.tabs.some((t) => t.id === id)) return { activeId: id };
      const tab: TableTab = { id, kind: "table", schema, name, objectKind: kind };
      return { tabs: [...state.tabs, tab], activeId: id };
    }),

  activate: (id) => set({ activeId: id }),

  close: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((t) => t.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== id);
      // Closing the front tab brings its right neighbour forward, else the left one.
      const activeId =
        state.activeId === id ? ((tabs[index] ?? tabs[index - 1])?.id ?? null) : state.activeId;
      return { tabs, activeId };
    }),

  closeAll: () => set({ tabs: [], activeId: null }),
}));
