import { TableIcon } from "lucide-react";

import { ActivityView } from "@/features/admin/ActivityView";
import { RolesView } from "@/features/admin/RolesView";
import { TableTabView } from "@/features/structure/TableTabView";
import { QueryView } from "@/features/query/QueryView";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";
import { Shortcut } from "@/features/shortcuts/Shortcut";

/** The main pane: whatever the front tab shows. */
export function ConnectedView() {
  const tab = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeId));
  const connectionId = useSessionStore((s) => s.activeConnectionId);

  if (!tab) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <TableIcon className="size-8 opacity-40" />
        <p className="text-sm">No tab open</p>
        <p className="text-xs">
          Pick a table in the sidebar, or press{" "}
          <kbd className="font-sans">
            <Shortcut id="tabs.new" />
          </kbd>{" "}
          for a new query.
        </p>
      </div>
    );
  }

  if (!connectionId) return null;

  if (tab.kind === "query") {
    // Keyed by tab: each query tab has its own editor, and its text is kept while it is hidden.
    return (
      <div className="min-h-0 flex-1">
        <QueryView key={tab.id} connectionId={connectionId} tab={tab} />
      </div>
    );
  }

  if (tab.kind === "activity") {
    return (
      <div className="min-h-0 flex-1">
        <ActivityView key={connectionId} connectionId={connectionId} />
      </div>
    );
  }

  if (tab.kind === "roles") {
    return (
      <div className="min-h-0 flex-1">
        <RolesView key={connectionId} connectionId={connectionId} />
      </div>
    );
  }

  // Keyed by tab: switching tabs gives each table its own sort, page and columns.
  return (
    <div className="min-h-0 flex-1">
      <TableTabView key={tab.id} connectionId={connectionId} tab={tab} />
    </div>
  );
}
