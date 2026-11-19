import { useCallback } from "react";
import { create } from "zustand";

import type { SortSpec } from "@/bindings";
import { EMPTY_LAYOUT, type ColumnLayout } from "@/features/grid/columns";
import { EMPTY_FILTER, type FilterState } from "@/features/grid/filters";
import { useTabsStore } from "@/stores/tabs";

export const PAGE_SIZES = [100, 500, 1000] as const;

/** What the user has done to one table tab: how it is filtered, sorted, paged and laid out. */
export interface TableView {
  sort: SortSpec[];
  /** 0-based. */
  page: number;
  pageSize: number;
  layout: ColumnLayout;
  filter: FilterState;
}

export const DEFAULT_VIEW: TableView = {
  sort: [],
  page: 0,
  pageSize: 500,
  layout: EMPTY_LAYOUT,
  filter: EMPTY_FILTER,
};

interface TableViewsState {
  views: Record<string, TableView>;
  update: (tabId: string, patch: Partial<TableView>) => void;
}

export const useTableViews = create<TableViewsState>()((set) => ({
  views: {},
  update: (tabId, patch) =>
    set((state) => ({
      views: { ...state.views, [tabId]: { ...(state.views[tabId] ?? DEFAULT_VIEW), ...patch } },
    })),
}));

/** The view state of a tab, and a function to change it. */
export function useTableView(tabId: string) {
  const view = useTableViews((s) => s.views[tabId] ?? DEFAULT_VIEW);
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
