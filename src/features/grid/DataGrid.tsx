import {
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type HeaderClickedEventArgs,
  type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ResultColumn, SortSpec } from "@/bindings";
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
import { useGridTheme } from "@/features/grid/gridTheme";
import { nextSort, superscript } from "@/features/grid/sort";

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
}: DataGridProps) {
  const theme = useGridTheme();
  const visible = useMemo(() => visibleColumns(columns, layout), [columns, layout]);
  const [menu, setMenu] = useState<MenuTarget | null>(null);

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

  // Cells are built on first draw and reused while the rows and columns stay the same.
  const cellCache = useRef<{
    rows: typeof rows;
    visible: typeof visible;
    cells: Map<number, GridCell>;
  } | null>(null);
  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = visible[col];
      if (!v) return LOADING_CELL;
      let cache = cellCache.current;
      if (!cache || cache.rows !== rows || cache.visible !== visible) {
        cache = { rows, visible, cells: new Map() };
        cellCache.current = cache;
      }
      const key = row * visible.length + col;
      let cell = cache.cells.get(key);
      if (!cell) {
        cell = cellFor(v.column, rows[row]?.[v.index] ?? null);
        cache.cells.set(key, cell);
      }
      return cell;
    },
    [visible, rows],
  );

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
            onColumnMoved={onColumnMoved}
            onHeaderClicked={onHeaderClicked}
            onHeaderContextMenu={(column) => {
              setMenu({ kind: "header", column });
            }}
            onCellContextMenu={([column, row]) => {
              setMenu({ kind: "cell", column, row });
            }}
          />
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
