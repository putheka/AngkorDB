import { KeyboardIcon, PanelLeftIcon } from "lucide-react";

import { Sidebar } from "@/components/layout/Sidebar";
import { StatusBar } from "@/components/layout/StatusBar";
import { TabBar } from "@/components/layout/TabBar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppearanceMenu } from "@/features/appearance/AppearanceMenu";
import { useTabShortcuts } from "@/features/tabs/useTabShortcuts";
import { QuitConfirmDialog } from "@/features/settings/quitConfirm";
import { ShortcutsDialog } from "@/features/shortcuts/ShortcutsDialog";
import { Shortcut } from "@/features/shortcuts/Shortcut";
import { commands } from "@/lib/ipc";
import { useShortcut, useShortcutDispatcher } from "@/features/shortcuts/registry";
import { useWorkspacePersistence } from "@/features/workspace/useWorkspacePersistence";
import { refreshData } from "@/features/grid/useTableData";
import { refreshSchema } from "@/features/sidebar/useSchema";
import { ConnectedView } from "@/features/connections/ConnectedView";
import { WelcomeScreen } from "@/features/connections/WelcomeScreen";
import { CommandPalette } from "@/features/palette/CommandPalette";
import { UnsavedChangesDialog } from "@/features/grid/editing/UnsavedChangesDialog";
import { useUnsavedSync } from "@/features/grid/editing/useUnsavedSync";
import { WriteApprovalDialog } from "@/features/safety/WriteApprovalDialog";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore } from "@/stores/palette";
import { useSessionStore } from "@/stores/session";
import { useShortcuts } from "@/stores/shortcuts";

/** Window layout: title bar · (welcome screen | sidebar + tabs) · status bar. */
export function AppShell() {
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const connected = activeId !== null;
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  useTabShortcuts(connected);
  useUnsavedSync();
  useWorkspacePersistence();

  useShortcutDispatcher();
  useShortcut("app.find", () => usePaletteStore.getState().toggle("objects"), {
    enabled: connected,
  });
  useShortcut("app.commands", () => usePaletteStore.getState().toggle("commands"), {
    enabled: connected,
  });
  useShortcut("app.sidebar", () => toggleSidebar(), { enabled: connected });
  // Also stops the webview from reloading the whole app.
  useShortcut(
    "app.reload",
    () => {
      if (!activeId) return false;
      void refreshSchema(activeId);
      void refreshData(activeId);
    },
    { enabled: connected },
  );
  useShortcut("app.shortcuts", () => useShortcuts.getState().toggleDialog());
  useShortcut("app.settings", () => void commands.openSettings());

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
            <TooltipContent>
              {sidebarCollapsed ? "Show" : "Hide"} sidebar (<Shortcut id="app.sidebar" />)
            </TooltipContent>
          </Tooltip>
        )}
        {/* Not a click target, so a press on the title still drags the window. */}
        <span className="pointer-events-none">AngkorDB</span>
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Keyboard shortcuts"
                onClick={() => useShortcuts.getState().openDialog()}
              >
                <KeyboardIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Keyboard shortcuts (<Shortcut id="app.shortcuts" />)
            </TooltipContent>
          </Tooltip>
          <AppearanceMenu />
        </div>
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

      {activeId && <CommandPalette connectionId={activeId} />}
      <UnsavedChangesDialog />
      <WriteApprovalDialog />
      <ShortcutsDialog />
      <QuitConfirmDialog />
      <StatusBar />
    </div>
  );
}
