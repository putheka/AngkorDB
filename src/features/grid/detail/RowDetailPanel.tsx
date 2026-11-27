import { SearchIcon, XIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import type { ColumnInfo, IncomingForeignKey } from "@/bindings";
import { Button } from "@/components/ui/button";
import { matchColumns } from "@/features/grid/columns";
import { DetailField } from "@/features/grid/detail/DetailField";
import { ReferencedBy } from "@/features/grid/detail/ReferencedBy";
import { groupOf, type ForeignKeyGroup } from "@/features/grid/foreignKeys";
import type { CellValue } from "@/features/grid/editing/changes";
import { isEditableColumn } from "@/features/grid/editing/editorKind";
import { DETAIL_MAX, DETAIL_MIN, useLayoutStore } from "@/stores/layout";

/** The row shown in the panel. */
export interface DetailRow {
  /** "Row 12" or "New row". */
  title: string;
  status: "normal" | "new" | "deleted";
  valueOf: (column: string) => CellValue;
  isEdited: (column: string) => boolean;
}

interface RowDetailPanelProps {
  connectionId: string;
  columns: ColumnInfo[];
  /** `null` when no row is selected. */
  row: DetailRow | null;
  /** The table can be edited at all (not a view, not read-only). */
  editable: boolean;
  onEdit: (column: string, value: CellValue) => void;
  onRevert: (column: string) => void;
  onClose: () => void;
  /** The table's schema and its foreign keys, in both directions. */
  schema: string;
  foreignKeys: ForeignKeyGroup[];
  incoming: IncomingForeignKey[];
  /** Open the row a key of this row points at. */
  onFollow: (group: ForeignKeyGroup) => void;
  /** Open the rows of another table that point at this row. */
  onOpenReferencing: (fk: IncomingForeignKey, values: string[]) => void;
}

const STEP = 16;

/** The drag handle on the panel's left edge. Arrow keys work too; double-click resets. */
function Resizer() {
  const width = useLayoutStore((s) => s.detailWidth);
  const setWidth = useLayoutStore((s) => s.setDetailWidth);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = {
      ArrowLeft: width + STEP,
      ArrowRight: width - STEP,
      Home: DETAIL_MIN,
      End: DETAIL_MAX,
    }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details"
      aria-valuenow={width}
      aria-valuemin={DETAIL_MIN}
      aria-valuemax={DETAIL_MAX}
      tabIndex={0}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { startX: e.clientX, startWidth: width };
      }}
      onPointerMove={(e) => {
        if (drag.current) setWidth(drag.current.startWidth - (e.clientX - drag.current.startX));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-ring/40 group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
}

/**
 * The selected row as a vertical form (Space toggles it). Edits go into the same staged
 * changes as edits in the grid, so ⌘S saves them together.
 */
export function RowDetailPanel({
  connectionId,
  columns,
  row,
  editable,
  onEdit,
  onRevert,
  onClose,
  schema,
  foreignKeys,
  incoming,
  onFollow,
  onOpenReferencing,
}: RowDetailPanelProps) {
  const width = useLayoutStore((s) => s.detailWidth);
  const writable = editable && row !== null && row.status !== "deleted";
  // Kept while moving between rows, so one column can be watched down the table.
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const shown = useMemo(() => matchColumns(columns, query), [columns, query]);

  return (
    <aside
      aria-label="Row details"
      style={{ width }}
      className="relative flex min-h-0 shrink-0 flex-col border-l bg-background"
    >
      <Resizer />
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-sm">
        <span className="font-medium">{row?.title ?? "Details"}</span>
        {row?.status === "new" && (
          <span className="rounded bg-green-500/20 px-1.5 text-xs text-green-700 dark:text-green-400">
            new
          </span>
        )}
        {row?.status === "deleted" && (
          <span className="rounded bg-red-500/20 px-1.5 text-xs text-red-700 dark:text-red-400">
            to be deleted
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close details"
          className="ml-auto"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      {row === null ? (
        <p className="p-4 text-sm text-muted-foreground">Select a row to see all its columns.</p>
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
            <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query !== "") {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Find a column"
              aria-label="Find a column"
              spellCheck={false}
              autoComplete="off"
              className="h-5 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
            {searching && (
              <>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {shown.length} of {columns.length}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                >
                  <XIcon />
                </Button>
              </>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
            {searching && shown.length === 0 && (
              <p className="text-center text-xs text-muted-foreground">
                No column matches &ldquo;{query.trim()}&rdquo;.
              </p>
            )}
            {shown.map((column) => {
              const group = groupOf(foreignKeys, column.name);
              const filled = group?.pairs.every((p) => row.valueOf(p.column).kind === "value");
              return (
                <DetailField
                  key={column.name}
                  connectionId={connectionId}
                  column={column}
                  value={row.valueOf(column.name)}
                  edited={row.isEdited(column.name)}
                  editable={writable && isEditableColumn(column)}
                  onChange={(value) => onEdit(column.name, value)}
                  onRevert={() => onRevert(column.name)}
                  {...(group
                    ? {
                        foreignKey: {
                          group,
                          canFollow: filled === true,
                          onFollow: () => onFollow(group),
                          onPick: (values: Record<string, string | null>) => {
                            for (const [name, text] of Object.entries(values)) {
                              onEdit(
                                name,
                                text === null ? { kind: "null" } : { kind: "value", text },
                              );
                            }
                          },
                        },
                      }
                    : {})}
                />
              );
            })}
            {row.status !== "new" && !searching && (
              <ReferencedBy
                connectionId={connectionId}
                schema={schema}
                incoming={incoming}
                valueOf={(name) => {
                  const value = row.valueOf(name);
                  return value.kind === "value" ? value.text : null;
                }}
                onOpen={onOpenReferencing}
              />
            )}
          </div>
        </>
      )}
    </aside>
  );
}
