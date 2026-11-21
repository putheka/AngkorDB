import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type CellClickedEventArgs,
  type DrawCellCallback,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type GridSelection,
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
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DELETED_ROW_THEME,
  NEW_ROW_THEME,
  cellFor,
  copyText,
  newRowCell,
} from "@/features/grid/cells";
import {
  MIN_WIDTH,
  autoWidth,
  moveColumn,
  orderedNames,
  visibleColumns,
  type ColumnLayout,
} from "@/features/grid/columns";
import { CellEditor, type Bounds } from "@/features/grid/editing/CellEditor";
import type { CellValue, NewRow } from "@/features/grid/editing/changes";
import { editorKindOf, isEditableColumn } from "@/features/grid/editing/editorKind";
import { useGridTheme } from "@/features/grid/gridTheme";
import { nextSort, superscript } from "@/features/grid/sort";
import {
  COPY_FORMATS,
  formatRows,
  type CopyColumn,
  type CopyFormat,
  type CopyRow,
  type RowKey,
} from "@/features/grid/clipboard/formats";
import { rowsFromText, type PasteColumn } from "@/features/grid/clipboard/parse";
import { gridMetrics } from "@/features/appearance/prefs";
import { errorMessage } from "@/lib/errors";
import { useAppearance } from "@/stores/appearance";

/** The row-number column is column 0 of the grid's own coordinates; ours start after it. */
const ROW_MARKER_OFFSET = 1;

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

/** A row of the grid: one the server sent (an index into this page) or one that is to be inserted. */
export type RowTarget = { kind: "page"; row: number } | { kind: "new"; id: string };

const NO_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};
const NO_NEW_ROWS: readonly NewRow[] = [];
const NO_DELETED: ReadonlySet<number> = new Set();

/** What makes a grid editable: left out, the grid is read-only. */
export interface GridEditing {
  connectionId: string;
  /** The table's columns from the catalog (types, nullability, generated). */
  columns: ColumnInfo[];
  /** The staged value of each edited cell, as `"row:column"` (indexes into this page). */
  overrides: ReadonlyMap<string, CellValue>;
  /** Rows to be inserted. They are drawn above the page, in this order. */
  newRows: readonly NewRow[];
  /** Rows of this page (indexes) that are marked for deletion. */
  deleted: ReadonlySet<number>;
  onEdit: (target: RowTarget, column: string, value: CellValue) => void;
  onRevert: (target: RowTarget, column: string) => void;
  onAddRow: () => void;
  /** ⌘D and the menu: a new row for each, with the values of the original. */
  onDuplicate: (targets: RowTarget[]) => void;
  /** Delete / Backspace and the menu: mark page rows (or take the mark off), drop new rows. */
  onDelete: (targets: RowTarget[]) => void;
  /** Pasted rows: each becomes a new row with these values (other columns stay `DEFAULT`). */
  onPasteRows: (rows: Record<string, CellValue>[]) => void;
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
  /** Space: show or hide the row detail panel. */
  onToggleDetail?: () => void;
  /** The row of the selected cell, as a grid row (new rows come first), or `null`. */
  onActiveRowChange?: (row: number | null) => void;
  /** Columns that are (part of) a foreign key get an arrow; following it opens the referenced rows. */
  foreignKeys?: ForeignKeyNavigation;
  /** The table the rows come from: lets "Copy as" write `INSERT` and `UPDATE` statements for it. */
  copyTarget?: CopyTarget;
}

export interface CopyTarget {
  schema: string;
  table: string;
  /** The columns that identify a row (primary key or unique index), or `null` without a usable key. */
  keyColumns: string[] | null;
}

/** The rows and columns a copy takes, as grid rows and shown-column indexes. */
interface CopyShape {
  rows: number[];
  columns: number[];
}

export interface ForeignKeyNavigation {
  /** Names of the columns that are part of a foreign key. */
  columns: ReadonlySet<string>;
  /** Open the rows the key of `row` (a grid row) points at. Rejects with a message to show. */
  onFollow: (row: number, column: string) => Promise<void>;
  /** Where the key leads, for the menu: `users`. */
  targetOf: (column: string) => string | undefined;
}

/** The part of an FK cell that follows the key when clicked, and where the arrow is drawn. */
const ARROW_ZONE = 22;

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
  onToggleDetail,
  onActiveRowChange,
  foreignKeys,
  copyTarget,
}: DataGridProps) {
  const theme = useGridTheme();
  const density = useAppearance((s) => s.density);
  const gridFontSize = useAppearance((s) => s.gridFontSize);
  const { rowHeight, headerHeight } = gridMetrics({ density, gridFontSize });
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
  const newRows = editing?.newRows ?? NO_NEW_ROWS;
  const deleted = editing?.deleted ?? NO_DELETED;
  /** Grid rows above the page: the rows that are to be inserted. */
  const newCount = newRows.length;

  /** What a grid row is: row `g` counts the new rows first. */
  const targetAt = (g: number): RowTarget | null => {
    const created = newRows[g];
    if (created) return { kind: "new", id: created.id };
    return g >= newCount ? { kind: "page", row: g - newCount } : null;
  };
  // The grid only tells us the selection (ours to keep) once it is given one to control.
  const [selection, setSelection] = useState<GridSelection>(NO_SELECTION);
  /** The rows under the selection: whole rows picked by their number, else the rows of the cells. */
  const selectedRows = (): number[] => {
    if (selection.rows.length > 0) return selection.rows.toArray();
    const range = selection.current?.range;
    return range ? Array.from({ length: range.height }, (_, i) => range.y + i) : [];
  };

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
    newRows: typeof newRows;
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
        cache.info !== info ||
        cache.newRows !== newRows
      ) {
        cache = { rows, visible, overrides, info, newRows, cells: new Map() };
        cellCache.current = cache;
      }
      const key = row * visible.length + col;
      let cell = cache.cells.get(key);
      if (!cell) {
        const found = info.get(v.column.name);
        const editable = found !== undefined && isEditableColumn(found);
        const created = newRows[row];
        if (created) {
          cell = newRowCell(v.column, created.values[v.column.name], editable);
        } else {
          const at = row - newCount;
          cell = cellFor(v.column, rows[at]?.[v.index] ?? null, {
            editable,
            edited: overrides?.get(`${at}:${v.index}`),
          });
        }
        cache.cells.set(key, cell);
      }
      return cell;
    },
    [visible, rows, overrides, info, newRows, newCount],
  );

  // New rows are green, rows to delete red with a line through the text.
  const getRowTheme = useCallback(
    (g: number) => {
      if (g < newCount) return NEW_ROW_THEME;
      return deleted.has(g - newCount) ? DELETED_ROW_THEME : undefined;
    },
    [newCount, deleted],
  );
  const fkColumns = foreignKeys?.columns;
  const drawCell = useMemo<DrawCellCallback | undefined>(() => {
    if (deleted.size === 0 && !fkColumns?.size) return undefined;
    return ({ ctx, cell, theme: cellTheme, rect, row, col }, drawContent) => {
      drawContent();
      if (cell.kind !== GridCellKind.Text) return;
      const right = cell.contentAlign === "right";

      // An arrow where the key can be followed: on the side the text is not (numbers sit on the right).
      const name = visible[col]?.column.name;
      if (name && fkColumns?.has(name) && cell.copyData !== "") {
        const x = right ? rect.x + 12 : rect.x + rect.width - 12;
        const y = rect.y + rect.height / 2;
        ctx.save();
        ctx.strokeStyle = "rgba(125, 135, 160, 0.95)";
        ctx.lineWidth = 1.4;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x - 5, y);
        ctx.lineTo(x + 4, y);
        ctx.moveTo(x + 1, y - 3.5);
        ctx.lineTo(x + 4.5, y);
        ctx.lineTo(x + 1, y + 3.5);
        ctx.stroke();
        ctx.restore();
      }

      // A line through the text of a row that is to be deleted.
      if (row < newCount || !deleted.has(row - newCount)) return;
      const text = cell.displayData ?? cell.data;
      if (text === "") return;
      ctx.save();
      ctx.font = `${cellTheme.baseFontStyle} ${cellTheme.fontFamily}`;
      const width = Math.min(
        ctx.measureText(text).width,
        rect.width - 2 * cellTheme.cellHorizontalPadding,
      );
      const x = right
        ? rect.x + rect.width - cellTheme.cellHorizontalPadding - width
        : rect.x + cellTheme.cellHorizontalPadding;
      ctx.strokeStyle = "rgba(239, 68, 68, 0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, Math.round(rect.y + rect.height / 2) + 0.5);
      ctx.lineTo(x + width, Math.round(rect.y + rect.height / 2) + 0.5);
      ctx.stroke();
      ctx.restore();
    };
  }, [deleted, newCount, fkColumns, visible]);

  /** Follow the key of a cell; a refusal ("NULL references nothing") shows as a notice. */
  const follow = (col: number, g: number) => {
    const name = visible[col]?.column.name;
    if (!foreignKeys || !name) return;
    foreignKeys.onFollow(g, name).catch((error: unknown) => setNotice(errorMessage(error)));
  };
  /** Clicking the arrow of an FK cell with a value, or ⌘-clicking the cell. */
  const onCellClicked = ([col, g]: Item, event: CellClickedEventArgs) => {
    const name = visible[col]?.column.name;
    if (!foreignKeys || !name || !foreignKeys.columns.has(name)) return;
    const cell = getCellContent([col, g]);
    if (cell.kind !== GridCellKind.Text || cell.copyData === "") return;
    const right = cell.contentAlign === "right";
    const onArrow = right
      ? event.localEventX <= ARROW_ZONE
      : event.localEventX >= event.bounds.width - ARROW_ZONE;
    if (onArrow || event.metaKey) follow(col, g);
  };

  // A new row appears at the top: show it.
  const previousNew = useRef(newCount);
  useEffect(() => {
    if (newCount > previousNew.current) grid.current?.scrollTo(0, 0);
    previousNew.current = newCount;
  }, [newCount]);

  /** The cell as it is now: staged edit if there is one, else what the server sent. */
  const currentValue = (g: number, col: number): CellValue => {
    const v = visible[col];
    if (!v) return { kind: "null" };
    const created = newRows[g];
    if (created) return created.values[v.column.name] ?? { kind: "default" };
    const row = g - newCount;
    const staged = overrides?.get(`${row}:${v.index}`);
    if (staged) return staged;
    const value = rows[row]?.[v.index] ?? null;
    return value === null ? { kind: "null" } : { kind: "value", text: value };
  };

  const isDeletedRow = (g: number) => g >= newCount && deleted.has(g - newCount);
  const refuseDeleted = (g: number) => {
    if (!isDeletedRow(g)) return false;
    setNotice("This row is marked for deletion. Press Delete to bring it back.");
    return true;
  };

  const startEdit = (col: number, g: number, typed?: string) => {
    if (!editing || !editableInfo(col) || refuseDeleted(g)) return;
    const bounds = grid.current?.getBounds(col, g);
    if (bounds) setEditor({ col, row: g, typed, bounds });
  };

  const stageValue = (col: number, g: number, value: CellValue) => {
    const column = visible[col]?.column.name;
    const target = targetAt(g);
    if (editing && column && target) editing.onEdit(target, column, value);
  };

  /** The rows a menu or key acts on: the selection if `g` is in it, else just `g`. */
  const targetsFor = (g: number): RowTarget[] => {
    const picked = selectedRows();
    const rowsToUse = picked.includes(g) ? picked : [g];
    return rowsToUse.flatMap((row) => targetAt(row) ?? []);
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
    if (editor) return;
    const command = e.metaKey || e.ctrlKey;
    // Space shows or hides the row details (instead of opening the cell editor, which Enter does).
    if (e.key === " " && !command && !e.altKey && !e.shiftKey && onToggleDetail) {
      e.cancel();
      e.preventDefault();
      onToggleDetail();
      return;
    }
    if (!editing) return;
    // Delete marks the selected rows for deletion (again: takes the mark off); ⌘D duplicates them.
    if (!command && !e.altKey && !e.shiftKey && (e.key === "Delete" || e.key === "Backspace")) {
      const targets = selectedRows().flatMap((g) => targetAt(g) ?? []);
      if (targets.length === 0) return;
      e.preventDefault();
      editing.onDelete(targets);
      return;
    }
    if (command && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "d") {
      const targets = selectedRows().flatMap((g) => targetAt(g) ?? []);
      if (targets.length === 0) return;
      e.preventDefault();
      editing.onDuplicate(targets);
      return;
    }
    if (!e.location) return;
    const [markedCol, row] = e.location;
    const col = markedCol - ROW_MARKER_OFFSET;
    if (!editableInfo(col)) return;
    // ⇧⌘⌫ is Discard (the table view's); ⌘⌫ alone sets NULL.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Backspace") {
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

  // ---- Copy and paste (ANG-28) ------------------------------------------------------------

  /**
   * What a copy takes. Rows picked by their number: those rows, every shown column. A range of
   * cells: that range. Otherwise, with a cell right-clicked, its row; with a lone selected cell,
   * just that cell.
   */
  const shapeOf = (clicked?: { row: number; col: number }): CopyShape | null => {
    const everyColumn = visible.map((_, i) => i);
    if (selection.rows.length > 0 && (!clicked || selection.rows.hasIndex(clicked.row))) {
      return { rows: selection.rows.toArray(), columns: everyColumn };
    }
    const range = selection.current?.range;
    if (range) {
      const inside =
        clicked &&
        clicked.row >= range.y &&
        clicked.row < range.y + range.height &&
        clicked.col >= range.x &&
        clicked.col < range.x + range.width;
      if (!clicked || inside) {
        return {
          rows: Array.from({ length: range.height }, (_, i) => range.y + i),
          columns: Array.from({ length: range.width }, (_, i) => range.x + i),
        };
      }
    }
    return clicked ? { rows: [clicked.row], columns: everyColumn } : null;
  };

  /** The row's key, from the values the server sent (an edited key still names the old row). */
  const keyOfRow = (g: number): RowKey[] | null => {
    const names = copyTarget?.keyColumns;
    const original = rows[g - newCount];
    if (!names || !original) return null;
    const key: RowKey[] = [];
    for (const name of names) {
      const at = columns.findIndex((c) => c.name === name);
      const column = columns[at];
      const value = original[at];
      if (!column || value === null || value === undefined) return null;
      key.push({ column: name, kind: editorKindOf(column), value });
    }
    return key;
  };

  /** The text a copy of `shape` would put on the clipboard, and how many rows it left out. */
  const textFor = (format: CopyFormat, shape: CopyShape) => {
    const shown = shape.columns.flatMap((i) => visible[i] ?? []);
    const copyColumns: CopyColumn[] = shown.map(({ column }) => ({
      name: column.name,
      kind: editorKindOf(column),
    }));
    const copyRows: CopyRow[] = shape.rows.map((g) => ({
      cells: shape.columns.map((i) => currentValue(g, i)),
      key: keyOfRow(g),
    }));
    // One cell is copied as it is, not as a table with one field.
    const only = copyRows.length === 1 && copyColumns.length === 1 ? copyRows[0]?.cells[0] : null;
    if (format === "tsv" && only) {
      return { text: only.kind === "value" ? only.text : "", skipped: 0 };
    }
    return formatRows(format, copyColumns, copyRows, {
      schema: copyTarget?.schema ?? "public",
      name: copyTarget?.table ?? "table",
    });
  };

  const copiedNotice = (format: CopyFormat, rowCount: number, skipped: number) => {
    const label = COPY_FORMATS.find((f) => f.format === format)?.label.split(" (")[0] ?? format;
    const skippedText = skipped > 0 ? ` (${skipped} without a key left out)` : "";
    setNotice(`Copied ${rowCount === 1 ? "1 row" : `${rowCount} rows`} as ${label}${skippedText}.`);
  };

  const copyShape = (format: CopyFormat, shape: CopyShape) => {
    const { text, skipped } = textFor(format, shape);
    if (text === "") {
      setNotice(
        format === "update" ? "Nothing to update: these rows have no key." : "Nothing to copy.",
      );
      return;
    }
    void navigator.clipboard.writeText(text).then(
      () => copiedNotice(format, shape.rows.length, skipped),
      () => setNotice("The clipboard would not accept the copy."),
    );
  };

  /** Turn clipboard text into new rows (positions follow the shown columns). */
  const pasteText = (source: string) => {
    if (!editing) return;
    const targets: PasteColumn[] = visible.flatMap(({ column }) => {
      const found = info.get(column.name);
      if (!found) return [];
      return {
        name: column.name,
        kind: editorKindOf(found),
        typeOid: found.typeOid,
        writable: isEditableColumn(found),
        hasDefault: found.defaultValue !== null || found.identity !== null,
      };
    });
    const result = rowsFromText(source, targets);
    if (!result.ok) {
      setNotice(result.error);
      return;
    }
    editing.onPasteRows(result.rows);
    const n = result.rows.length;
    const extras = [
      result.skipped.length > 0 ? `${result.skipped.join(", ")} is generated, not pasted` : null,
      result.ignoredFields > 0 ? `${result.ignoredFields} extra fields left out` : null,
    ].filter((x): x is string => x !== null);
    setNotice(
      `Pasted ${n === 1 ? "1 new row" : `${n} new rows`}${extras.length > 0 ? ` (${extras.join("; ")})` : ""}. Save with ⌘S.`,
    );
  };

  // ⌘C and ⌘V arrive as copy and paste events (the app menu sends them), while the grid has focus.
  // They are caught here, before the grid's own handlers, so what is copied is what is on screen,
  // with edits and new rows, and a pasted table becomes new rows.
  const latest = useRef({ shapeOf, textFor, copiedNotice, pasteText, hasEditor: false });
  useEffect(() => {
    latest.current = { shapeOf, textFor, copiedNotice, pasteText, hasEditor: editor !== null };
  });
  useEffect(() => {
    const inGrid = () => wrapper.current?.contains(document.activeElement) === true;
    const onCopy = (e: ClipboardEvent) => {
      if (!inGrid() || latest.current.hasEditor) return;
      const shape = latest.current.shapeOf();
      if (!shape) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const { text } = latest.current.textFor("tsv", shape);
      e.clipboardData?.setData("text/plain", text);
      latest.current.copiedNotice("tsv", shape.rows.length, 0);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!inGrid() || latest.current.hasEditor) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      latest.current.pasteText(e.clipboardData?.getData("text/plain") ?? "");
    };
    window.addEventListener("copy", onCopy, true);
    window.addEventListener("paste", onPaste, true);
    return () => {
      window.removeEventListener("copy", onCopy, true);
      window.removeEventListener("paste", onPaste, true);
    };
  }, []);

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
  // The menu's row as text: a page row, or a new row (a value that was set, else empty).
  const menuRow =
    menu?.kind === "cell"
      ? newRows[menu.row]
        ? columns.map((c) => {
            const set = newRows[menu.row]?.values[c.name];
            return set?.kind === "value" ? set.text : null;
          })
        : rows[menu.row - newCount]
      : undefined;
  const menuIsNew = menu?.kind === "cell" && menu.row < newCount;
  const menuPageRow = menu?.kind === "cell" ? menu.row - newCount : -1;
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
            rows={rows.length + newCount}
            getCellContent={getCellContent}
            getRowThemeOverride={getRowTheme}
            {...(drawCell ? { drawCell } : {})}
            gridSelection={selection}
            onGridSelectionChange={(picked) => {
              setSelection(picked);
              const row = picked.current?.cell[1] ?? picked.rows.first();
              onActiveRowChange?.(row ?? null);
            }}
            theme={theme}
            headerIcons={HEADER_ICONS}
            rowHeight={rowHeight}
            headerHeight={headerHeight}
            rowMarkers={{ kind: "clickable-number", startIndex: firstRowNumber }}
            getCellsForSelection={true}
            onPaste={false}
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
            onCellClicked={onCellClicked}
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
                {(menuIsNew
                  ? newRows[menu.row]?.values[menuColumn.column.name] !== undefined
                  : overrides?.has(`${menuPageRow}:${menuColumn.index}`)) && (
                  <ContextMenuItem
                    onSelect={() => {
                      const target = targetAt(menu.row);
                      if (target) editing.onRevert(target, menuColumn.column.name);
                    }}
                  >
                    {menuIsNew ? "Back to DEFAULT" : "Revert change"}
                  </ContextMenuItem>
                )}
                <ContextMenuSeparator />
              </>
            )}
            {foreignKeys?.columns.has(menuColumn.column.name) &&
              menuRow?.[menuColumn.index] != null && (
                <>
                  <ContextMenuItem onSelect={() => follow(menu.column, menu.row)}>
                    Go to {foreignKeys.targetOf(menuColumn.column.name) ?? "referenced row"}
                    <ContextMenuShortcut>⌘-click</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                </>
              )}
            {editing && (
              <>
                <ContextMenuItem onSelect={() => editing.onDuplicate(targetsFor(menu.row))}>
                  Duplicate row
                  <ContextMenuShortcut>⌘D</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => editing.onDelete(targetsFor(menu.row))}>
                  {menuIsNew
                    ? "Remove new row"
                    : deleted.has(menuPageRow)
                      ? "Keep row (undo delete)"
                      : "Delete row"}
                  <ContextMenuShortcut>⌫</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            )}
            {onFilterByValue && !menuIsNew && (
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
            <ContextMenuSub>
              <ContextMenuSubTrigger>Copy as</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {COPY_FORMATS.filter(
                  ({ format }) => copyTarget || (format !== "insert" && format !== "update"),
                ).map(({ format, label }) => (
                  <ContextMenuItem
                    key={format}
                    disabled={format === "update" && !copyTarget?.keyColumns}
                    onSelect={() => {
                      const shape = shapeOf({ row: menu.row, col: menu.column });
                      if (shape) copyShape(format, shape);
                    }}
                  >
                    {label}
                    {format === "tsv" && <ContextMenuShortcut>⌘C</ContextMenuShortcut>}
                    {format === "update" && !copyTarget?.keyColumns && (
                      <ContextMenuShortcut>needs a key</ContextMenuShortcut>
                    )}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem
              onSelect={() => {
                const shape = shapeOf({ row: menu.row, col: menu.column });
                const names = (shape?.columns ?? [menu.column])
                  .flatMap((i) => visible[i]?.column.name ?? [])
                  .join(", ");
                copyToClipboard(names);
              }}
            >
              Copy column names
            </ContextMenuItem>
            {editing && (
              <ContextMenuItem
                onSelect={() =>
                  void navigator.clipboard
                    .readText()
                    .then(pasteText, () => setNotice("Allow pasting, or paste with ⌘V."))
                }
              >
                Paste as new rows
                <ContextMenuShortcut>⌘V</ContextMenuShortcut>
              </ContextMenuItem>
            )}
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
