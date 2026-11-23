import { ActivityIcon, PlugZapIcon, ShieldIcon } from "lucide-react";
import { Suspense } from "react";

import { SidebarResizer } from "@/components/layout/SidebarResizer";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ColorDot } from "@/features/connections/ColorDot";
import { SavedQueries } from "@/features/query/history/SavedQueries";
import { ObjectTree } from "@/features/sidebar/ObjectTree";
import { useConnections } from "@/features/connections/useConnections";
import { lazyNamed } from "@/lib/lazyNamed";
import { useBackupDialog } from "@/stores/backupDialog";
import { useImportDialog } from "@/stores/importDialog";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";

const ImportHost = lazyNamed(() => import("@/features/import/ImportHost"), "ImportHost");
const BackupDialog = lazyNamed(() => import("@/features/backup/BackupDialog"), "BackupDialog");

/** The open connection on top, then its databases, schemas and objects. */
export function Sidebar() {
  const width = useLayoutStore((s) => s.sidebarWidth);
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const disconnect = useSessionStore((s) => s.disconnect);
  const { data: connections = [] } = useConnections();
  const active = connections.find((c) => c.id === activeId);
  const importing = useImportDialog((s) => s.seed !== null);
  const backing = useBackupDialog((s) => s.open);

  return (
    <aside
      data-sidebar
      style={{ width }}
      className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border pr-1 pl-3">
        {active && <ColorDot color={active.color} />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{active?.name}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Activity"
              onClick={() => useTabsStore.getState().openActivity()}
            >
              <ActivityIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Activity: processes and locks</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Roles"
              onClick={() => useTabsStore.getState().openRoles()}
            >
              <ShieldIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Roles and privileges</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Disconnect"
              onClick={() => void disconnect()}
            >
              <PlugZapIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Disconnect</TooltipContent>
        </Tooltip>
      </div>

      {activeId && <ObjectTree key={`tree:${activeId}`} connectionId={activeId} />}
      {/* Loaded when something asks for them (a menu item, ⌘K, a dropped file). */}
      <Suspense fallback={null}>
        {activeId && importing && <ImportHost connectionId={activeId} />}
        {activeId && backing && <BackupDialog connectionId={activeId} />}
      </Suspense>
      {activeId && (
        <SavedQueries
          key={`saved:${activeId}`}
          connectionId={activeId}
          connectionName={active?.name ?? ""}
        />
      )}

      <SidebarResizer />
    </aside>
  );
}
