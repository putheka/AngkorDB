import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { RowQuery } from "@/bindings";
import type { FilterState } from "@/features/grid/filters";
import type { TableView } from "@/features/grid/tableViews";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import type { TableTab } from "@/stores/tabs";

/** Prefix of every cached row and count query of one connection. */
export const dataKey = (connectionId: string) => ["data", connectionId] as const;

/** Re-read the rows of every open table (⌘R, the refresh button). */
export function refreshData(connectionId: string) {
  return queryClient.invalidateQueries({ queryKey: dataKey(connectionId) });
}

/** One page of the table, as the tab's sort and paging say. Keeps the old page while the next loads. */
export function useTableRows(connectionId: string, tab: TableTab, view: TableView) {
  const query = useMemo<RowQuery>(
    () => ({
      schema: tab.schema,
      table: tab.name,
      limit: view.pageSize,
      offset: view.page * view.pageSize,
      sort: view.sort,
      filters: view.filter.applied.filters,
      rawWhere: view.filter.applied.rawWhere,
    }),
    [tab.schema, tab.name, view.pageSize, view.page, view.sort, view.filter.applied],
  );

  return useQuery({
    queryKey: [...dataKey(connectionId), "rows", query],
    queryFn: async () => {
      const started = performance.now();
      const page = await commands.fetchRows(connectionId, query);
      // Round trip as the UI sees it: query, transfer and IPC.
      return { page, ms: performance.now() - started };
    },
    placeholderData: keepPreviousData,
  });
}

/**
 * How many rows match: the planner's estimate (instant) for a whole table, otherwise a real
 * `count(*)`, which scans. The caller decides when that is worth it (`enabled`).
 */
export function useRowCount(
  connectionId: string,
  tab: TableTab,
  applied: FilterState["applied"],
  exact: boolean,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...dataKey(connectionId), "count", tab.schema, tab.name, applied, exact],
    queryFn: () =>
      commands.countRows(
        connectionId,
        tab.schema,
        tab.name,
        applied.filters,
        applied.rawWhere,
        exact,
      ),
    enabled,
  });
}

/** The table's columns and types from the catalog: known even while the rows are loading or failing. */
export function useTableColumns(connectionId: string, tab: TableTab) {
  return useQuery({
    queryKey: ["schema", connectionId, "describe", tab.schema, tab.name],
    queryFn: () => commands.describeTable(connectionId, tab.schema, tab.name),
  });
}
