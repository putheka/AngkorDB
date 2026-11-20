import { useCallback, useEffect, useMemo, useState } from "react";

import type { RowCount } from "@/bindings";
import { useConnections } from "@/features/connections/useConnections";
import { Button } from "@/components/ui/button";
import type { ColumnLayout } from "@/features/grid/columns";
import { DataGrid, type GridEditing } from "@/features/grid/DataGrid";
import { PendingBar, ReadOnlyBanner } from "@/features/grid/editing/Banners";
import { useChangesStore, useTabChanges } from "@/features/grid/editing/changeStore";
import {
  overridesFor,
  pendingCells,
  pendingRows,
  revertCell,
  rowRefOf,
  keyOf,
  setCell,
} from "@/features/grid/editing/changes";
import { FilterBar } from "@/features/grid/FilterBar";
import {
  appliedCount,
  clearAll,
  openBar,
  withValueFilter,
  type FilterState,
} from "@/features/grid/filters";
import { GridFooter } from "@/features/grid/GridFooter";
import { useTableView } from "@/features/grid/tableViews";
import {
  refreshData,
  useRowCount,
  useTableColumns,
  useTableRows,
} from "@/features/grid/useTableData";
import { errorDetails, errorMessage } from "@/lib/errors";
import { useStatusStore } from "@/stores/status";
import type { TableTab } from "@/stores/tabs";

/** `count` arrives as null when Postgres reports no number (it can't, but JSON can't say NaN). */
function estimateOf(count: RowCount | undefined) {
  return count && count.count !== null ? { count: count.count, exact: count.exact } : null;
}

/** The contents of a table tab: filter bar, rows page by page with sorting, and the footer. */
export function TableView({ connectionId, tab }: { connectionId: string; tab: TableTab }) {
  const { view, update } = useTableView(tab.id);
  const rows = useTableRows(connectionId, tab, view);
  const described = useTableColumns(connectionId, tab);
  const [focusToken, setFocusToken] = useState(0);
  // Which filter the user asked an exact count for. A new filter starts over.
  const [exactFor, setExactFor] = useState<string | null>(null);

  const filter = view.filter;
  const filterCount = appliedCount(filter);
  const appliedKey = JSON.stringify(filter.applied);
  const exact = exactFor === appliedKey;

  const page = rows.data?.page;
  const offset = view.page * view.pageSize;
  // The first page already holds every row: no need to ask for a count.
  const knowsEverything = page !== undefined && view.page === 0 && !page.hasMore;
  // A filter has no cheap estimate and `count(*)` scans, so with one the count waits to be asked for.
  const count = useRowCount(
    connectionId,
    tab,
    filter.applied,
    exact,
    page !== undefined && !knowsEverything && (filterCount === 0 || exact),
  );

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

  // Staged edits (ANG-22). A table can be edited when its rows can be told apart and the
  // connection allows writes; otherwise the reason is shown instead.
  const changes = useTabChanges(tab.id);
  const { data: connections = [] } = useConnections();
  const safeMode = connections.find((c) => c.id === connectionId)?.safeMode;
  const readOnlyReason =
    safeMode === "read-only"
      ? "This connection is read-only (safe mode)."
      : page?.identity.kind === "readOnly"
        ? page.identity.reason
        : null;
  const refs = useMemo(() => (page ? page.rows.map((_, i) => rowRefOf(page, i)) : []), [page]);
  const overrides = useMemo(
    () => (page ? overridesFor(page, refs, changes) : new Map()),
    [page, refs, changes],
  );
  const editing = useMemo<GridEditing | undefined>(() => {
    if (!page || !described.data || readOnlyReason) return undefined;
    const change = useChangesStore.getState().change;
    return {
      connectionId,
      columns: described.data.columns,
      overrides,
      onEdit: (row, column, value) => {
        const ref = refs[row];
        const at = page.columns.findIndex((c) => c.name === column);
        if (!ref || at === -1) return;
        const original = page.rows[row]?.[at] ?? null;
        change(tab.id, (c) => setCell(c, ref, column, original, value));
      },
      onRevert: (row, column) => {
        const ref = refs[row];
        if (ref) change(tab.id, (c) => revertCell(c, keyOf(ref), column));
      },
    };
  }, [page, described.data, readOnlyReason, connectionId, overrides, refs, tab.id]);
  const pending = pendingCells(changes);

  // The columns come from the catalog, so the bar works even when the rows failed to load.
  const filterColumns = (described.data?.columns ?? page?.columns ?? []).map((c) => ({
    name: c.name,
    typeName: c.typeName,
  }));
  const firstColumn = filterColumns[0]?.name ?? "";

  const openFilter = useCallback(() => {
    update({ filter: openBar(filter, firstColumn) });
    setFocusToken((t) => t + 1);
  }, [update, filter, firstColumn]);
  const closeFilter = () => update({ filter: { ...filter, open: false } });
  const applyFilter = (next: FilterState) => update({ filter: next, page: 0 });

  // ⌘F opens the bar. The sidebar's own ⌘F (focus in the sidebar) has already claimed the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.code !== "KeyF") return;
      e.preventDefault();
      openFilter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFilter]);

  let body;
  if (rows.isPending) {
    body = <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>;
  } else if (rows.isError || !page) {
    body = (
      <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center text-sm">
        <p className="font-medium text-destructive">{errorMessage(rows.error)}</p>
        {errorDetails(rows.error).map((line) => (
          <p key={line} className="text-xs text-muted-foreground">
            {line}
          </p>
        ))}
        <div className="mt-1 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void rows.refetch()}>
            Try again
          </Button>
          {filterCount > 0 && (
            <>
              {!filter.open && (
                <Button variant="outline" size="sm" onClick={openFilter}>
                  Edit filter
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => update({ filter: clearAll(filter, firstColumn), page: 0 })}
              >
                Clear filter
              </Button>
            </>
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div
          className={
            rows.isPlaceholderData
              ? "relative min-h-0 flex-1 opacity-60"
              : "relative min-h-0 flex-1"
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
            onFilterByValue={(column, value) =>
              update({ filter: withValueFilter(filter, column, value), page: 0 })
            }
            {...(editing ? { editing } : {})}
          />
          {page.rows.length === 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-24 text-center text-sm text-muted-foreground">
              {filterCount > 0 ? "No rows match the filter." : "This table has no rows."}
            </p>
          )}
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
          onCountExactly={() => setExactFor(appliedKey)}
          filterCount={filterCount}
          filterOpen={filter.open}
          onToggleFilter={filter.open ? closeFilter : openFilter}
        />
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {filter.open && (
        <FilterBar
          columns={filterColumns}
          state={filter}
          onChange={(next) => update({ filter: next })}
          onApply={applyFilter}
          onClose={closeFilter}
          focusToken={focusToken}
        />
      )}
      {readOnlyReason && page && <ReadOnlyBanner reason={readOnlyReason} />}
      {pending > 0 && (
        <PendingBar
          cells={pending}
          rows={pendingRows(changes)}
          onDiscard={() => useChangesStore.getState().discard(tab.id)}
        />
      )}
      {body}
    </div>
  );
}
