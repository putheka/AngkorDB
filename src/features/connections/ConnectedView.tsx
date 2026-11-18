import { TableIcon } from "lucide-react";

/** The pane when no tab is open. Tabs (ANG-13) replace this when there is one. */
export function ConnectedView() {
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
