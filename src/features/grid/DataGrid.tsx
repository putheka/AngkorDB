import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type HeaderClickedEventArgs,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ColumnInfo, ResultColumn, SortSpec } from "@/bindings";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cellFor, copyText } from "@/features/grid/cells";
import {
  MIN_WIDTH,
  autoWidth,
  moveColumn,
  orderedNames,
  visibleColumns,
  type ColumnLayout,
} from "@/features/grid/columns";
import { CellEditor, type Bounds } from "@/features/grid/editing/CellEditor";
import type { CellValue } from "@/features/grid/editing/changes";
import { isEditableColumn } from "@/features/grid/editing/editorKind";
import { useGridTheme } from "@/features/grid/gridTheme";
import { nextSort, superscript } from "@/features/grid/sort";

/** The row-number column is column 0 of the grid's own coordinates; ours start after it. */
const ROW_MARKER_OFFSET = 1;
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;

const arrow = (path: string) => (props: { fgColor: string }) =>
  `<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="${path}" fill="${props.fgColor}"/></svg>`;

/** Sort arrows drawn left of a column title. */
const HEADER_ICONS = {
  sortAsc: arrow("M10 5l5 7H5z"),
  sortDesc: arrow("M10 15l5-7H5z"),
};

const LOADING_CELL: GridCell = {
  kind: GridCellKind.Text,
  data: "",
  displayData: "",
  allowOverlay: false,
};

type MenuTarget =
  { kind: "header"; column: number } | { kind: "cell"; column: number; row: number };

/** What makes a grid editable: left out, the grid is read-only. */
export interface GridEditing {
  connectionId: string;
  /** The table's columns from the catalog (types, nullability, generated). */
  columns: ColumnInfo[];
  /** The staged value of each edited cell, as `"row:column"` (indexes into this page). */
  overrides: ReadonlyMap<string, CellValue>;
  onEdit: (row: number, column: string, value: CellValue) => void;
  onRevert: (row: number, column: string) => void;
}

interface EditorState {
  /** Column and row of the cell, as shown (hidden columns are not counted). */
  col: number;
  row: number;
  typed: string | undefined;
  bounds: Bounds;
}

export interface DataGridProps {
  columns: ResultColumn[];
  /** Every cell as text, `null` for SQL NULL. One entry per column. */
  rows: (string | null)[][];
  /** Number of the first row, for the row numbers: page 2 of 500 starts at 501. */
  firstRowNumber: number;
  layout: ColumnLayout;
  onLayoutChange: (layout: ColumnLayout) => void;
  sort: SortSpec[];
  onSortChange: (sort: SortSpec[]) => void;
  /** "Filter by this value" in the cell menu. `null` means the cell is NULL. Left out: no item. */
  onFilterByValue?: (column: string, value: string | null) => void;
  editing?: GridEditing;
}

/**
 * Canvas grid for rows of text: NULL in grey italics, numbers right-aligned, booleans as
 * checkboxes, long values cut. Headers sort (shift-click adds a column), columns resize, move
 * and hide, and ⌘C copies the selection as tab-separated text. Shared by the table tabs and,
 * later, query results.
 */
export function DataGrid({
  columns,
  rows,
  firstRowNumber,
  layout,
  onLayoutChange,
  sort,
  onSortChange,
  onFilterByValue,
  editing,
}: DataGridProps) {
  const theme = useGridTheme();
  const visible = useMemo(() => visibleColumns(columns, layout), [columns, layout]);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const grid = useRef<DataEditorRef>(null);

  // Which shown column can be edited, and what the catalog says about it.
  const info = useMemo(
    () => new Map((editing?.columns ?? []).map((c) => [c.name, c])),
    [editing?.columns],
  );
  const editableInfo = (col: number) => {
    const column = visible[col]?.column;
    const found = column ? info.get(column.name) : undefined;
    return found && isEditableColumn(found) ? found : undefined;
  };
  const overrides = editing?.overrides;

  // Widths the user hasn't set are worked out once, from the first page, and then kept: pages
  // must not change column widths under the reader.
  const missing = visible.filter((v) => layout.widths[v.column.name] === undefined);
  useEffect(() => {
    if (missing.length === 0 || rows.length === 0) return;
    const widths = { ...layout.widths };
    for (const v of missing) widths[v.column.name] = autoWidth(v.column, v.index, rows);
    onLayoutChange({ ...layout, widths });
  }, [missing, rows, layout, onLayoutChange]);

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      visible.map(({ column }) => {
        const at = sort.findIndex((s) => s.column === column.name);
        const spec = sort[at];
        return {
          id: column.name,
          title: spec && sort.length > 1 ? `${column.name} ${superscript(at + 1)}` : column.name,
          width: layout.widths[column.name] ?? 120,
          ...(spec ? { icon: spec.dir === "asc" ? "sortAsc" : "sortDesc" } : {}),
        };
      }),
    [visible, sort, layout.widths],
  );

  // Cells are built on first draw and reused while the rows, columns and edits stay the same.
  const cellCache = useRef<{
    rows: typeof rows;
    visible: typeof visible;
    overrides: typeof overrides;
    info: typeof info;
    cells: Map<number, GridCell>;
  } | null>(null);
  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = visible[col];
      if (!v) return LOADING_CELL;
      let cache = cellCache.current;
      if (
        !cache ||
        cache.rows !== rows ||
        cache.visible !== visible ||
        cache.overrides !== overrides ||
        cache.info !== info
      ) {
        cache = { rows, visible, overrides, info, cells: new Map() };
        cellCache.current = cache;
      }
      const key = row * visible.length + col;
      let cell = cache.cells.get(key);
      if (!cell) {
        const found = info.get(v.column.name);
        cell = cellFor(v.column, rows[row]?.[v.index] ?? null, {
          editable: found !== undefined && isEditableColumn(found),
          edited: overrides?.get(`${row}:${v.index}`),
        });
        cache.cells.set(key, cell);
      }
      return cell;
    },
    [visible, rows, overrides, info],
  );

  /** The cell as it is now: staged edit if there is one, else what the server sent. */
  const currentValue = (row: number, col: number): CellValue => {
    const v = visible[col];
    if (!v) return { kind: "null" };
    const staged = overrides?.get(`${row}:${v.index}`);
    if (staged) return staged;
    const value = rows[row]?.[v.index] ?? null;
    return value === null ? { kind: "null" } : { kind: "value", text: value };
  };

  const startEdit = (col: number, row: number, typed?: string) => {
    if (!editing || !editableInfo(col)) return;
    const bounds = grid.current?.getBounds(col, row);
    if (bounds) setEditor({ col, row, typed, bounds });
  };

  const stageValue = (col: number, row: number, value: CellValue) => {
    const column = visible[col]?.column.name;
    if (editing && column) editing.onEdit(row, column, value);
  };

  const setNullAt = (col: number, row: number) => {
    const found = editableInfo(col);
    if (!found) return;
    if (!found.nullable) {
      setNotice(`${found.name} can't be NULL.`);
      return;
    }
    stageValue(col, row, { kind: "null" });
  };

  // Typing on a selected cell starts editing with that key; ⌘⌫ sets NULL.
  const onKeyDown = (e: GridKeyEventArgs) => {
    if (!editing || editor || !e.location) return;
    const [markedCol, row] = e.location;
    const col = markedCol - ROW_MARKER_OFFSET;
    if (!editableInfo(col)) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      e.preventDefault();
      setNullAt(col, row);
    } else if (!e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && e.key !== " ") {
      e.preventDefault();
      startEdit(col, row, e.key);
    }
  };

  const closeEditor = () => {
    setEditor(null);
    grid.current?.focus();
  };

  // The message about a refused edit goes away on its own.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(timer);
  }, [notice]);

  const onHeaderClicked = (col: number, event: HeaderClickedEventArgs) => {
    const name = visible[col]?.column.name;
    if (name) onSortChange(nextSort(sort, name, event.shiftKey));
  };

  const onColumnMoved = (from: number, to: number) => {
    const name = visible[from]?.column.name;
    const target = visible[to]?.column.name;
    if (!name || !target) return;
    onLayoutChange({
      ...layout,
      order: moveColumn(orderedNames(columns, layout), name, target),
    });
  };

  const hide = (name: string) => onLayoutChange({ ...layout, hidden: [...layout.hidden, name] });
  const sortBy = (name: string, dir: "asc" | "desc") =>
    onSortChange([...sort.filter((s) => s.column !== name), { column: name, dir }]);

  const menuColumn = menu ? visible[menu.column] : undefined;
  const menuRow = menu?.kind === "cell" ? rows[menu.row] : undefined;
  const wrapper = useRef<HTMLDivElement>(null);

  return (
    <ContextMenu onOpenChange={(open) => !open && setMenu(null)}>
      <ContextMenuTrigger asChild>
        {/* Clears the target first; the grid's own handlers then set it for what was hit. */}
        <div
          ref={wrapper}
          className="relative h-full min-h-0 w-full"
          onContextMenuCapture={() => setMenu(null)}
        >
          <DataEditor
            ref={grid}
            width="100%"
            height="100%"
            columns={gridColumns}
            rows={rows.length}
            getCellContent={getCellContent}
            theme={theme}
            headerIcons={HEADER_ICONS}
            rowHeight={ROW_HEIGHT}
            headerHeight={HEADER_HEIGHT}
            rowMarkers={{ kind: "number", startIndex: firstRowNumber }}
            getCellsForSelection={true}
            columnSelect="none"
            smoothScrollX
            smoothScrollY
            onColumnResize={(column, width) => {
              if (column.id) {
                onLayoutChange({
                  ...layout,
                  widths: { ...layout.widths, [column.id]: Math.max(MIN_WIDTH, Math.round(width)) },
                });
              }
            }}
            onCellActivated={([col, row]) => startEdit(col, row)}
            onKeyDown={onKeyDown}
            onVisibleRegionChanged={() => editor && setEditor(null)}
            onColumnMoved={onColumnMoved}
            onHeaderClicked={onHeaderClicked}
            onHeaderContextMenu={(column) => {
              setMenu({ kind: "header", column });
            }}
            onCellContextMenu={([column, row]) => {
              setMenu({ kind: "cell", column, row });
            }}
          />
          {editor && editing && editableInfo(editor.col) && (
            <CellEditor
              key={`${editor.row}:${editor.col}`}
              connectionId={editing.connectionId}
              column={editableInfo(editor.col) as ColumnInfo}
              current={currentValue(editor.row, editor.col)}
              typed={editor.typed}
              bounds={editor.bounds}
              onCommit={(value) => {
                stageValue(editor.col, editor.row, value);
                closeEditor();
              }}
              onCancel={closeEditor}
            />
          )}
          {notice && (
            <p
              role="status"
              className="pointer-events-none absolute bottom-3 left-3 rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow"
            >
              {notice}
            </p>
          )}
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent>
        {menu?.kind === "header" && menuColumn && (
          <>
            <ContextMenuItem onSelect={() => sortBy(menuColumn.column.name, "asc")}>
              Sort ascending
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => sortBy(menuColumn.column.name, "desc")}>
              Sort descending
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!sort.some((s) => s.column === menuColumn.column.name)}
              onSelect={() => onSortChange(sort.filter((s) => s.column !== menuColumn.column.name))}
            >
              Clear sort
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => hide(menuColumn.column.name)}>
              Hide column
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => copyToClipboard(menuColumn.column.name)}>
              Copy column name
            </ContextMenuItem>
          </>
        )}
        {menu?.kind === "cell" && menuColumn && menuRow && (
          <>
            {editing && editableInfo(menu.column) && (
              <>
                <ContextMenuItem onSelect={() => startEdit(menu.column, menu.row)}>
                  Edit
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setNullAt(menu.column, menu.row)}>
                  Set NULL
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => stageValue(menu.column, menu.row, { kind: "default" })}
                >
                  Set DEFAULT
                </ContextMenuItem>
                {overrides?.has(`${menu.row}:${menuColumn.index}`) && (
                  <ContextMenuItem
                    onSelect={() => editing.onRevert(menu.row, menuColumn.column.name)}
                  >
                    Revert change
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
            {onFilterByValue && (
              <>
                <ContextMenuItem
                  onSelect={() =>
                    onFilterByValue(menuColumn.column.name, menuRow[menuColumn.index] ?? null)
                  }
                >
                  Filter by this value
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            <ContextMenuItem
              onSelect={() => copyToClipboard(copyText(menuRow[menuColumn.index] ?? null))}
            >
              Copy value
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() =>
                copyToClipboard(visible.map((v) => copyText(menuRow[v.index] ?? null)).join("\t"))
              }
            >
              Copy row
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => copyToClipboard(menuColumn.column.name)}>
              Copy column name
            </ContextMenuItem>
          </>
        )}
        {!menu && <ContextMenuItem disabled>Nothing here</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function copyToClipboard(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}
