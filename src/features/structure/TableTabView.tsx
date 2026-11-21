import { TableView } from "@/features/grid/TableView";
import { useTableView } from "@/features/grid/tableViews";
import { StructureView } from "@/features/structure/StructureView";
import { useShortcut } from "@/features/shortcuts/registry";
import { otherMode, type TableMode } from "@/features/structure/sections";
import { cn } from "@/lib/utils";
import type { TableTab } from "@/stores/tabs";
import { Shortcut } from "@/features/shortcuts/Shortcut";

const MODES: { id: TableMode; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "structure", label: "Structure" },
];

/** A table tab: its rows, or how it is built, with the switch at the bottom. */
export function TableTabView({ connectionId, tab }: { connectionId: string; tab: TableTab }) {
  const { view, update } = useTableView(tab.id);
  const mode = view.mode;

  // Rows or structure. Its keys use ⌥, since ⇧⌘[ and ⇧⌘] cycle the tabs.
  useShortcut("table.mode", () => update({ mode: otherMode(mode) }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {mode === "data" ? (
          <TableView connectionId={connectionId} tab={tab} />
        ) : (
          <StructureView
            connectionId={connectionId}
            tab={tab}
            section={view.section}
            onSection={(section) => update({ section })}
          />
        )}
      </div>
      <div
        role="tablist"
        aria-label="Table view"
        className="flex h-8 shrink-0 items-center gap-1 border-t bg-muted/30 px-2"
      >
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => update({ mode: id })}
            className={cn(
              "rounded-md px-3 py-0.5 text-xs",
              mode === id
                ? "bg-background font-medium shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">
          <Shortcut id="table.mode" /> switches
        </span>
      </div>
    </div>
  );
}
