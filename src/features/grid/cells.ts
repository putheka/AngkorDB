import { GridCellKind, type GridCell, type Theme } from "@glideapps/glide-data-grid";

import type { ResultColumn } from "@/bindings";
import { isBoolean, isNumeric } from "@/features/grid/columns";
import type { CellValue } from "@/features/grid/editing/changes";
import { formatTemporal } from "@/features/grid/temporal";
import { DEFAULT_DISPLAY, nullText, type DisplayPrefs } from "@/features/settings/generalPrefs";

/** Cells longer than this are cut for drawing; the full value stays in `data` for copy/overlay. */
const MAX_DISPLAY = 200;

/** `NULL` is drawn grey and italic, so it can't be mistaken for the text "NULL" or an empty string. */
const NULL_THEME: Partial<Theme> = {
  textDark: "rgba(128, 128, 128, 0.9)",
  baseFontStyle: "italic 13px",
};

/** A NULL cell, with the text the person chose for it. */
function nullCell(numeric: boolean, display: DisplayPrefs): GridCell {
  const cell: GridCell = {
    kind: GridCellKind.Text,
    data: "",
    displayData: nullText(display.nullDisplay),
    copyData: "",
    allowOverlay: false,
    readonly: true,
    themeOverride: NULL_THEME,
  };
  return numeric ? { ...cell, contentAlign: "right" } : cell;
}

/** One line, not too long: new lines become ⏎ so a multi-line value stays on one row. */
export function displayText(value: string): string {
  const oneLine = value.replace(/\r\n|\r|\n/g, "⏎");
  return oneLine.length > MAX_DISPLAY ? `${oneLine.slice(0, MAX_DISPLAY)}…` : oneLine;
}

/** Edited cells get a yellow background (ANG-22), in both light and dark mode. */
const EDITED_BG = "rgba(250, 204, 21, 0.22)";

/** A cell that is to become DEFAULT: the value is only known to the server. */
const DEFAULT_CELL: GridCell = {
  kind: GridCellKind.Text,
  data: "",
  displayData: "DEFAULT",
  copyData: "",
  allowOverlay: false,
  readonly: true,
  themeOverride: { ...NULL_THEME, bgCell: EDITED_BG },
};

/** `DEFAULT` in a new row: the row is already tinted green, so no yellow here. */
const NEW_DEFAULT_CELL: GridCell = { ...DEFAULT_CELL, themeOverride: NULL_THEME };

/** Row tints: new rows are green, rows to delete red (the strike-through is drawn by the grid). */
export const NEW_ROW_THEME: Partial<Theme> = { bgCell: "rgba(34, 197, 94, 0.16)" };
export const DELETED_ROW_THEME: Partial<Theme> = {
  bgCell: "rgba(239, 68, 68, 0.16)",
  textDark: "rgba(140, 140, 140, 0.95)",
};

export interface CellOptions {
  /** The cell can be edited: it opens the editor, not the read-only viewer. */
  editable?: boolean;
  /** What the cell is staged to become, if it has been edited. */
  edited?: CellValue | undefined;
  /** How NULLs, dates and times are written. */
  display?: DisplayPrefs;
}

/**
 * How one value is drawn. Values arrive as text from Postgres and stay text, so a bigint above
 * 2^53 or a numeric(30,10) keeps every digit; numbers are only right-aligned.
 */
export function cellFor(
  column: ResultColumn,
  value: string | null,
  options: CellOptions = {},
): GridCell {
  const { edited } = options;
  if (edited?.kind === "default") return DEFAULT_CELL;
  const shown = edited ? (edited.kind === "null" ? null : edited.text) : value;

  const cell = plainCell(
    column,
    shown,
    options.editable === true,
    options.display ?? DEFAULT_DISPLAY,
  );
  if (!edited) return cell;
  return { ...cell, themeOverride: { ...cell.themeOverride, bgCell: EDITED_BG } };
}

/** A cell of a row that is to be inserted: its value if one was set, else `DEFAULT`. */
export function newRowCell(
  column: ResultColumn,
  value: CellValue | undefined,
  editable: boolean,
  display: DisplayPrefs = DEFAULT_DISPLAY,
): GridCell {
  if (value === undefined || value.kind === "default") return NEW_DEFAULT_CELL;
  return plainCell(column, value.kind === "null" ? null : value.text, editable, display);
}

function plainCell(
  column: ResultColumn,
  value: string | null,
  editable: boolean,
  display: DisplayPrefs,
): GridCell {
  const numeric = isNumeric(column);
  if (value === null) return nullCell(numeric, display);

  if (isBoolean(column) && (value === "true" || value === "false")) {
    return {
      kind: GridCellKind.Boolean,
      data: value === "true",
      copyData: value,
      allowOverlay: false,
      readonly: true,
    };
  }

  return {
    kind: GridCellKind.Text,
    data: value,
    // Dates and times are written as chosen; the value that is copied or edited stays as sent.
    displayData: displayText(formatTemporal(value, column.typeName, display)),
    // Editable cells open the editor; the others show the whole value on double-click or Enter.
    allowOverlay: !editable,
    readonly: true,
    ...(numeric ? { contentAlign: "right" as const } : {}),
  };
}

/** A cell as plain text, the way it is copied. `NULL` copies as nothing. */
export function copyText(value: string | null): string {
  return value ?? "";
}
