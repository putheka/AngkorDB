import { useEffect } from "react";

import { TableView } from "@/features/grid/TableView";
import { useTableView } from "@/features/grid/tableViews";
import { StructureView } from "@/features/structure/StructureView";
import { otherMode, type TableMode } from "@/features/structure/sections";
import { cn } from "@/lib/utils";
import type { TableTab } from "@/stores/tabs";

const MODES: { id: TableMode; label: string }[] = [
  { id: "data", label: "Data" },
  { id: "structure", label: "Structure" },
];

/** A table tab: its rows, or how it is built, with the switch at the bottom (⌘⌥] and ⌘⌥[). */
export function TableTabView({ connectionId, tab }: { connectionId: string; tab: TableTab }) {
  const { view, update } = useTableView(tab.id);
  const mode = view.mode;

  // ⇧⌘[ and ⇧⌘] cycle the tabs, so these use ⌥ instead of ⇧. `code`: ⌥] types something else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
      if (e.code !== "BracketRight" && e.code !== "BracketLeft") return;
      e.preventDefault();
      update({ mode: otherMode(mode) });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, update]);

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
        <span className="ml-auto text-[11px] text-muted-foreground">⌘⌥] switches</span>
      </div>
    </div>
  );
}
