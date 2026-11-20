import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RowCount } from "@/bindings";
import { Button } from "@/components/ui/button";
import type { ColumnLayout } from "@/features/grid/columns";
import { DataGrid, type GridEditing, type RowTarget } from "@/features/grid/DataGrid";
import { RowDetailPanel, type DetailRow } from "@/features/grid/detail/RowDetailPanel";
import {
  foreignKeyColumns,
  foreignKeyGroups,
  groupOf,
  type ForeignKeyGroup,
} from "@/features/grid/foreignKeys";
import { openTableWhere } from "@/features/grid/fkNavigation";
import { PendingBar, ReadOnlyBanner } from "@/features/grid/editing/Banners";
import { useWriteApproval } from "@/features/safety/approval";
import { useChangesStore, useTabChanges } from "@/features/grid/editing/changeStore";
import {
  EMPTY_CHANGES,
  addNewRow,
  describePending,
  duplicateValues,
  isDeleted,
  keyOf,
  overridesFor,
  removeNewRows,
  revertCell,
  rowRefOf,
  setCell,
  setNewCell,
  summarize,
  toTableChanges,
  toggleDeleted,
  type CellValue,
} from "@/features/grid/editing/changes";
import { PreviewDialog } from "@/features/grid/editing/PreviewDialog";
import { useCommitChanges } from "@/features/grid/editing/useCommit";
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
import { commands } from "@/lib/ipc";
import { useLayoutStore } from "@/stores/layout";
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
  const { mode: safeMode, name: connectionName, approve } = useWriteApproval(connectionId);
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
  const deleted = useMemo(
    () => new Set(refs.flatMap((ref, i) => (ref && isDeleted(changes, ref) ? [i] : []))),
    [refs, changes],
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const commit = useCommitChanges(connectionId, tab, () => setPreviewOpen(false));
  // No edits while writing: the staged copy is dropped when the write is done.
  const writing = commit.isPending;
  /** A cell of this page as it is now: the staged edit, else what the server sent. */
  const pageValue = useCallback(
    (row: number, name: string): CellValue => {
      const at = page?.columns.findIndex((c) => c.name === name) ?? -1;
      const staged = overrides.get(`${row}:${at}`);
      if (staged) return staged;
      const original = page?.rows[row]?.[at] ?? null;
      return original === null ? { kind: "null" } : { kind: "value", text: original };
    },
    [page, overrides],
  );
  const editing = useMemo<GridEditing | undefined>(() => {
    if (!page || !described.data || readOnlyReason || writing) return undefined;
    const change = useChangesStore.getState().change;
    const columns = described.data.columns;
    return {
      connectionId,
      columns,
      overrides,
      newRows: changes.inserts,
      deleted,
      onEdit: (target, column, value) => {
        if (target.kind === "new") {
          change(tab.id, (c) => setNewCell(c, target.id, column, value));
          return;
        }
        const ref = refs[target.row];
        const at = page.columns.findIndex((c) => c.name === column);
        if (!ref || at === -1) return;
        const original = page.rows[target.row]?.[at] ?? null;
        change(tab.id, (c) => setCell(c, ref, column, original, value));
      },
      onRevert: (target, column) => {
        if (target.kind === "new") {
          change(tab.id, (c) => setNewCell(c, target.id, column, { kind: "default" }));
          return;
        }
        const ref = refs[target.row];
        if (ref) change(tab.id, (c) => revertCell(c, keyOf(ref), column));
      },
      onAddRow: () => change(tab.id, (c) => addNewRow(c, { id: crypto.randomUUID(), values: {} })),
      onDuplicate: (targets) =>
        change(tab.id, (c) =>
          targets.reduce((acc, target) => {
            const valueOf = (name: string): CellValue =>
              target.kind === "page"
                ? pageValue(target.row, name)
                : (acc.inserts.find((r) => r.id === target.id)?.values[name] ?? {
                    kind: "default",
                  });
            return addNewRow(acc, {
              id: crypto.randomUUID(),
              values: duplicateValues(columns, valueOf),
            });
          }, c),
        ),
      onPasteRows: (pasted) =>
        change(tab.id, (c) =>
          pasted.reduce((acc, values) => addNewRow(acc, { id: crypto.randomUUID(), values }), c),
        ),
      onDelete: (targets) => {
        const gone = new Set(targets.flatMap((t) => (t.kind === "new" ? [t.id] : [])));
        const marked = targets.flatMap((t) => (t.kind === "page" ? (refs[t.row] ?? []) : []));
        change(tab.id, (c) => toggleDeleted(removeNewRows(c, gone), marked));
      },
    };
  }, [
    page,
    described.data,
    readOnlyReason,
    writing,
    connectionId,
    overrides,
    refs,
    tab.id,
    changes.inserts,
    deleted,
    pageValue,
  ]);
  const summary = useMemo(() => summarize(changes), [changes]);

  // The row details panel (Space) shows the row the selected cell is in. `activeRow` counts new
  // rows first, the way the grid does.
  const detailOpen = useLayoutStore((s) => s.detailOpen);
  const toggleDetail = useLayoutStore((s) => s.toggleDetail);

  // Foreign keys (ANG-27): outgoing ones from the catalog columns, incoming ones ("referenced
  // by") only when the panel is there to show them.
  const fkGroups = useMemo(
    () => (described.data ? foreignKeyGroups(described.data.columns) : []),
    [described.data],
  );
  const fkColumns = useMemo(() => foreignKeyColumns(fkGroups), [fkGroups]);
  const incoming = useQuery({
    queryKey: ["schema", connectionId, "incoming", tab.schema, tab.name],
    queryFn: () => commands.listIncomingForeignKeys(connectionId, tab.schema, tab.name),
    enabled: detailOpen,
  });

  /** What a grid row holds in a column right now, `null` for NULL or an unset new row. */
  const textOf = useCallback(
    (g: number, name: string): string | null => {
      const created = changes.inserts[g];
      const value = created
        ? (created.values[name] ?? { kind: "default" as const })
        : pageValue(g - changes.inserts.length, name);
      return value.kind === "value" ? value.text : null;
    },
    [changes.inserts, pageValue],
  );
  const followGroup = useCallback(
    async (group: ForeignKeyGroup, valueOf: (column: string) => string | null) => {
      const conditions = group.pairs.map((p) => ({ column: p.target, value: valueOf(p.column) }));
      if (conditions.some((c) => c.value === null)) {
        throw new Error("This key is NULL, so it points at no row.");
      }
      await openTableWhere(
        connectionId,
        group.schema,
        group.table,
        conditions.map((c) => ({ column: c.column, value: c.value ?? "" })),
      );
    },
    [connectionId],
  );
  const foreignKeys = useMemo(
    () =>
      fkColumns.size === 0
        ? undefined
        : {
            columns: fkColumns,
            onFollow: async (g: number, column: string) => {
              const group = groupOf(fkGroups, column);
              if (group) await followGroup(group, (name) => textOf(g, name));
            },
            targetOf: (column: string) => groupOf(fkGroups, column)?.table,
          },
    [fkColumns, fkGroups, followGroup, textOf],
  );

  const [activeRow, setActiveRow] = useState<number | null>(null);
  const detail = useMemo<{ key: string; target: RowTarget | null; row: DetailRow | null }>(() => {
    const none = { key: "none", target: null, row: null };
    if (!detailOpen || activeRow === null || !page) return none;
    const created = changes.inserts[activeRow];
    if (created) {
      return {
        key: `new:${created.id}`,
        target: { kind: "new", id: created.id },
        row: {
          title: "New row",
          status: "new",
          valueOf: (name) => created.values[name] ?? { kind: "default" },
          isEdited: (name) => created.values[name] !== undefined,
        },
      };
    }
    const row = activeRow - changes.inserts.length;
    if (row < 0 || !page.rows[row]) return none;
    const ref = refs[row];
    return {
      key: ref ? keyOf(ref) : `row:${row}`,
      target: { kind: "page", row },
      row: {
        title: `Row ${offset + 1 + activeRow}`,
        status: deleted.has(row) ? "deleted" : "normal",
        valueOf: (name) => pageValue(row, name),
        isEdited: (name) => {
          const at = page.columns.findIndex((c) => c.name === name);
          return overrides.has(`${row}:${at}`);
        },
      },
    };
  }, [detailOpen, activeRow, page, changes.inserts, refs, offset, deleted, pageValue, overrides]);
  const pending = summary.total;
  const tableChanges = useMemo(() => toTableChanges(changes), [changes]);

  // A new edit makes the last failure moot.
  const { mutate: commitNow, reset: resetCommit, isPending: committing } = commit;

  const committingRef = useRef(false);
  useEffect(() => {
    committingRef.current = committing;
  });

  // Saving asks first when the connection's safe mode says so (ANG-25). A refused Touch ID
  // (not a cancelled one) is shown like a failed save, until the next edit.
  const [approval, setApproval] = useState<{ changes: typeof changes; error: unknown } | null>(
    null,
  );
  const approving = useRef(false);
  const requestCommit = useCallback(async () => {
    const staged = useChangesStore.getState().byTab[tab.id] ?? EMPTY_CHANGES;
    const pendingNow = summarize(staged);
    if (pendingNow.total === 0 || approving.current || committingRef.current) return;
    approving.current = true;
    setApproval(null);
    try {
      const approved = await approve({
        title: `Save changes to ${connectionName}?`,
        lines: [describePending(pendingNow), `in ${tab.schema}.${tab.name}`],
        reason: `save changes to ${connectionName}`,
      });
      if (approved) commitNow();
    } catch (error) {
      setApproval({ changes: staged, error });
    } finally {
      approving.current = false;
    }
  }, [approve, commitNow, connectionName, tab.id, tab.schema, tab.name]);

  useEffect(() => {
    // Not while writing: the write itself drops the staged edits when it is done.
    if (!committingRef.current) resetCommit();
  }, [changes, resetCommit]);

  // ⌘S writes, ⇧⌘P shows the SQL, ⇧⌘⌫ throws the edits away.
  useEffect(() => {
    const staged = () => summarize(useChangesStore.getState().byTab[tab.id] ?? EMPTY_CHANGES).total;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.altKey || e.ctrlKey) return;
      const typing =
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(e.target.tagName));
      if (e.code === "KeyS" && !e.shiftKey) {
        e.preventDefault();
        // An open cell editor holds an edit that isn't staged yet: closing it stages it.
        const active = document.activeElement;
        if (active instanceof HTMLElement && active.closest("[data-cell-editor]")) active.blur();
        if (staged() > 0 && !committing) void requestCommit();
      } else if (e.code === "KeyP" && e.shiftKey) {
        e.preventDefault();
        if (staged() > 0) setPreviewOpen(true);
      } else if (e.code === "Backspace" && e.shiftKey && !typing) {
        e.preventDefault();
        useChangesStore.getState().discard(tab.id);
        setPreviewOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tab.id, committing, requestCommit]);

  // ⌘I adds a row at the top.
  const addRow = editing?.onAddRow;
  useEffect(() => {
    if (!addRow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.code !== "KeyI") return;
      e.preventDefault();
      addRow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [addRow]);

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
            onToggleDetail={toggleDetail}
            onActiveRowChange={setActiveRow}
            {...(foreignKeys ? { foreignKeys } : {})}
            copyTarget={{
              schema: tab.schema,
              table: tab.name,
              keyColumns:
                page.identity.kind === "primaryKey" || page.identity.kind === "uniqueIndex"
                  ? page.identity.columns
                  : null,
            }}
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
          {...(addRow ? { onAddRow: addRow } : {})}
          detailOpen={detailOpen}
          onToggleDetail={toggleDetail}
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
          summary={summary}
          committing={committing}
          error={commit.error ?? (approval?.changes === changes ? approval.error : null)}
          onPreview={() => setPreviewOpen(true)}
          onCommit={() => void requestCommit()}
          onDiscard={() => {
            useChangesStore.getState().discard(tab.id);
            setPreviewOpen(false);
          }}
        />
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">{body}</div>
        {detailOpen && page && described.data && (
          <RowDetailPanel
            key={detail.key}
            connectionId={connectionId}
            columns={described.data.columns}
            row={detail.row}
            editable={editing !== undefined}
            onEdit={(column, value) =>
              detail.target && editing?.onEdit(detail.target, column, value)
            }
            onRevert={(column) => detail.target && editing?.onRevert(detail.target, column)}
            onClose={toggleDetail}
            schema={tab.schema}
            foreignKeys={fkGroups}
            incoming={incoming.data ?? []}
            onFollow={(group) => {
              const valueOf = (name: string) => {
                const value = detail.row?.valueOf(name);
                return value?.kind === "value" ? value.text : null;
              };
              void followGroup(group, valueOf).catch(() => undefined);
            }}
            onOpenReferencing={(fk, values) =>
              void openTableWhere(
                connectionId,
                fk.schema,
                fk.table,
                fk.columns.map((column, i) => ({ column, value: values[i] ?? "" })),
              ).catch(() => undefined)
            }
          />
        )}
      </div>
      <PreviewDialog
        open={previewOpen && pending > 0}
        onOpenChange={setPreviewOpen}
        connectionId={connectionId}
        schema={tab.schema}
        table={tab.name}
        changes={tableChanges}
        committing={committing}
        onCommit={() => void requestCommit()}
      />
    </div>
  );
}
