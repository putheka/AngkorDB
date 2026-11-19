import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { RowQuery } from "@/bindings";
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
      filters: [],
      rawWhere: null,
    }),
    [tab.schema, tab.name, view.pageSize, view.page, view.sort],
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
 * How many rows the table has: the planner's estimate (instant), or with `exact` a real count,
 * which scans the table. Skipped when the first page already showed every row.
 */
export function useRowCount(connectionId: string, tab: TableTab, exact: boolean, enabled: boolean) {
  return useQuery({
    queryKey: [...dataKey(connectionId), "count", tab.schema, tab.name, exact],
    queryFn: () => commands.countRows(connectionId, tab.schema, tab.name, [], null, exact),
    enabled,
  });
}
