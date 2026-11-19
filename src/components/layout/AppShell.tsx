import { PanelLeftIcon } from "lucide-react";
import { useEffect } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { StatusBar } from "@/components/layout/StatusBar";
import { TabBar } from "@/components/layout/TabBar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useTabShortcuts } from "@/features/tabs/useTabShortcuts";
import { refreshData } from "@/features/grid/useTableData";
import { refreshSchema } from "@/features/sidebar/useSchema";
import { ConnectedView } from "@/features/connections/ConnectedView";
import { WelcomeScreen } from "@/features/connections/WelcomeScreen";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/session";

/** Window layout: title bar · (welcome screen | sidebar + tabs) · status bar. */
export function AppShell() {
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const connected = activeId !== null;
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  useTabShortcuts(connected);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!connected || !e.metaKey) return;
      if (e.key === "0") {
        e.preventDefault();
        toggleSidebar();
      } else if (e.key === "r" && activeId) {
        // Also stops the webview from reloading the whole app.
        e.preventDefault();
        void refreshSchema(activeId);
        void refreshData(activeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connected, activeId, toggleSidebar]);

  return (
    <div className="flex h-full flex-col">
      {/* Overlay title bar: leave room for the macOS traffic lights */}
      <header
        data-tauri-drag-region
        className="flex h-10 shrink-0 items-center gap-2 border-b pr-3 pl-20 text-xs font-medium text-muted-foreground"
      >
        {connected && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
                aria-pressed={!sidebarCollapsed}
                onClick={toggleSidebar}
              >
                <PanelLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{sidebarCollapsed ? "Show" : "Hide"} sidebar (⌘0)</TooltipContent>
          </Tooltip>
        )}
        {/* Not a click target, so a press on the title still drags the window. */}
        <span className="pointer-events-none">AngkorDB</span>
      </header>

      <div className="flex min-h-0 flex-1">
        {connected ? (
          <>
            {!sidebarCollapsed && <Sidebar />}
            <main className="flex min-w-0 flex-1 flex-col">
              <TabBar />
              <ConnectedView />
            </main>
          </>
        ) : (
          <main className="min-w-0 flex-1">
            <WelcomeScreen />
          </main>
        )}
      </div>

      <StatusBar />
    </div>
  );
}
