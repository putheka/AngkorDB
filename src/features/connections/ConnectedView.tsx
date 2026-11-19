import { SquareTerminalIcon, TableIcon } from "lucide-react";

import { tabTitle, useTabsStore } from "@/stores/tabs";

/** The main pane: whatever the front tab shows. The grid (ANG-18) and editor (ANG-20) replace these. */
export function ConnectedView() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));

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

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-muted-foreground">
      <p className="text-sm font-medium text-foreground">
        {tab.schema}.{tab.name}
      </p>
      <p className="text-xs">Rows will appear here.</p>
    </div>
  );
}
