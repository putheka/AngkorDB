import { useCallback, useEffect, useState } from "react";

import type { RowCount } from "@/bindings";
import { Button } from "@/components/ui/button";
import type { ColumnLayout } from "@/features/grid/columns";
import { DataGrid } from "@/features/grid/DataGrid";
import { GridFooter } from "@/features/grid/GridFooter";
import { useTableView } from "@/features/grid/tableViews";
import { refreshData, useRowCount, useTableRows } from "@/features/grid/useTableData";
import { errorDetails, errorMessage } from "@/lib/errors";
import { useStatusStore } from "@/stores/status";
import type { TableTab } from "@/stores/tabs";

/** `count` arrives as null when Postgres reports no number (it can't, but JSON can't say NaN). */
function estimateOf(count: RowCount | undefined) {
  return count && count.count !== null ? { count: count.count, exact: count.exact } : null;
}

/** The contents of a table tab: the rows page by page, with sorting and the footer. */
export function TableView({ connectionId, tab }: { connectionId: string; tab: TableTab }) {
  const { view, update } = useTableView(tab.id);
  const rows = useTableRows(connectionId, tab, view);
  const [exactCount, setExactCount] = useState(false);

  const page = rows.data?.page;
  const offset = view.page * view.pageSize;
  // The first page already holds every row: no need to ask for a count.
  const knowsEverything = page !== undefined && view.page === 0 && !page.hasMore;
  const count = useRowCount(connectionId, tab, exactCount, page !== undefined && !knowsEverything);

  const total = knowsEverything
    ? { count: page.rows.length, exact: true }
    : page && !page.hasMore
      ? { count: offset + page.rows.length, exact: true } // last page: now we know
      : estimateOf(count.data);

  // The status bar shows the front tab's size and timing.
  const queryMs = rows.data?.ms ?? null;
  useEffect(() => {
    if (queryMs === null) return;
    useStatusStore.getState().set({ rowCount: total, queryMs });
  }, [total?.count, total?.exact, queryMs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => useStatusStore.getState().clear(), []);

  const onLayoutChange = useCallback((layout: ColumnLayout) => update({ layout }), [update]);

  if (rows.isPending) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (rows.isError || !page) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center text-sm">
        <p className="font-medium text-destructive">{errorMessage(rows.error)}</p>
        {errorDetails(rows.error).map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
        <Button variant="outline" size="sm" onClick={() => void rows.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={
          rows.isPlaceholderData ? "relative min-h-0 flex-1 opacity-60" : "relative min-h-0 flex-1"
        }
      >
        <DataGrid
          columns={page.columns}
          rows={page.rows}
          firstRowNumber={offset + 1}
          layout={view.layout}
          onLayoutChange={onLayoutChange}
          sort={view.sort}
          onSortChange={(sort) => update({ sort, page: 0 })}
        />
      </div>
      <GridFooter
        page={view.page}
        pageSize={view.pageSize}
        rowCount={page.rows.length}
        hasMore={page.hasMore}
        total={total}
        fetching={rows.isFetching}
        columns={page.columns}
        layout={view.layout}
        onPage={(next) => update({ page: next })}
        onPageSize={(pageSize) => update({ pageSize, page: 0 })}
        onLayoutChange={onLayoutChange}
        onRefresh={() => void refreshData(connectionId)}
        onCountExactly={() => setExactCount(true)}
      />
    </div>
  );
}
