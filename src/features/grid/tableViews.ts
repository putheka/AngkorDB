import { useCallback, useMemo } from "react";
import { create } from "zustand";

import type { SortSpec } from "@/bindings";
import { EMPTY_LAYOUT, type ColumnLayout } from "@/features/grid/columns";
import { EMPTY_FILTER, type FilterState } from "@/features/grid/filters";
import type { Section, TableMode } from "@/features/structure/sections";
import { useGeneral } from "@/stores/general";
import { useTabsStore } from "@/stores/tabs";

export { PAGE_SIZES } from "@/features/settings/generalPrefs";

/** What the user has done to one table tab: how it is filtered, sorted, paged and laid out. */
export interface TableView {
  sort: SortSpec[];
  /** 0-based. */
  page: number;
  pageSize: number;
  layout: ColumnLayout;
  filter: FilterState;
  /** Rows, or how the table is built (ANG-36). */
  mode: TableMode;
  /** Which part of the structure is open. */
  section: Section;
}

export const DEFAULT_VIEW: TableView = {
  sort: [],
  page: 0,
  pageSize: 500,
  layout: EMPTY_LAYOUT,
  filter: EMPTY_FILTER,
  mode: "data",
  section: "columns",
};

/** A table that is opened for the first time: the defaults, with the page size of the settings. */
const newTableView = (): TableView => ({
  ...DEFAULT_VIEW,
  pageSize: useGeneral.getState().pageSize,
});

interface TableViewsState {
  views: Record<string, TableView>;
  update: (tabId: string, patch: Partial<TableView>) => void;
}

export const useTableViews = create<TableViewsState>()((set) => ({
  views: {},
  update: (tabId, patch) =>
    set((state) => ({
      views: {
        ...state.views,
        [tabId]: { ...(state.views[tabId] ?? newTableView()), ...patch },
      },
    })),
}));

/** The view state of a tab, and a function to change it. */
export function useTableView(tabId: string) {
  const saved = useTableViews((s) => s.views[tabId]);
  const pageSize = useGeneral((s) => s.pageSize);
  const view = useMemo(() => saved ?? { ...DEFAULT_VIEW, pageSize }, [saved, pageSize]);
  const updateView = useTableViews((s) => s.update);
  const update = useCallback(
    (patch: Partial<TableView>) => updateView(tabId, patch),
    [updateView, tabId],
  );
  return { view, update };
}

// A closed tab takes its view with it.
useTabsStore.subscribe((state) => {
  const open = new Set(state.tabs.map((t) => t.id));
  const { views } = useTableViews.getState();
  const stale = Object.keys(views).filter((id) => !open.has(id));
  if (stale.length === 0) return;
  useTableViews.setState({
    views: Object.fromEntries(Object.entries(views).filter(([id]) => open.has(id))),
  });
});
