import { SquareTerminalIcon, TableIcon } from "lucide-react";

import { TableView } from "@/features/grid/TableView";
import { useSessionStore } from "@/stores/session";
import { tabTitle, useTabsStore } from "@/stores/tabs";

/** The main pane: whatever the front tab shows. The SQL editor (ANG-20) replaces the query placeholder. */
export function ConnectedView() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const connectionId = useSessionStore((s) => s.activeConnectionId);

  if (!tab) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <TableIcon className="size-8 opacity-40" />
        <p className="text-sm">No tab open</p>
        <p className="text-xs">
          Pick a table in the sidebar, or press <kbd className="font-sans">⌘T</kbd> for a new query.
        </p>
      </div>
    );
  }

  if (tab.kind === "query") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <SquareTerminalIcon className="size-8 opacity-40" />
        <p className="text-sm font-medium text-foreground">{tabTitle(tab)}</p>
        <p className="text-xs">The SQL editor comes soon.</p>
      </div>
    );
  }

  if (!connectionId) return null;
  // Keyed by tab: switching tabs gives each table its own sort, page and columns.
  return (
    <div className="min-h-0 flex-1">
      <TableView key={tab.id} connectionId={connectionId} tab={tab} />
    </div>
  );
}
