import { TableIcon } from "lucide-react";

import { useTabsStore } from "@/stores/tabs";

/** The main pane. Shows the table in front; the data grid replaces this text (ANG-18). */
export function ConnectedView() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));

  if (tab) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center text-muted-foreground">
        <p className="text-sm font-medium text-foreground">
          {tab.schema}.{tab.name}
        </p>
        <p className="text-xs">Rows will appear here.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
      <TableIcon className="size-8 opacity-40" />
      <p className="text-sm">No table open</p>
      <p className="text-xs">
        Pick a table in the sidebar. <kbd className="font-sans">⌘0</kbd> shows or hides it.
      </p>
    </div>
  );
}
