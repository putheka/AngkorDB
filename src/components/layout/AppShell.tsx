import { KeyboardIcon, PanelLeftIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { StatusBar } from "@/components/layout/StatusBar";
import { TabBar } from "@/components/layout/TabBar";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AppearanceMenu } from "@/features/appearance/AppearanceMenu";
import { useTabShortcuts } from "@/features/tabs/useTabShortcuts";
import { QuitConfirmDialog } from "@/features/settings/quitConfirm";
import { Shortcut } from "@/features/shortcuts/Shortcut";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import { useLaunchUpdateCheck } from "@/features/updates/useLaunchUpdateCheck";
import { commands } from "@/lib/ipc";
import { useAppearance } from "@/stores/appearance";
import { useBackupDialog } from "@/stores/backupDialog";
import { useBrowserStore } from "@/stores/browser";
import { useImportDialog } from "@/stores/importDialog";
import { useUpdates } from "@/stores/updates";
import { useWelcome } from "@/stores/welcome";
import { useNativeMenu } from "@/features/shortcuts/nativeMenu";
import { FileDropZone } from "@/features/import/FileDropZone";
import { useDockOpen } from "@/features/workspace/useDockOpen";
import { runFirst, useShortcut, useShortcutDispatcher } from "@/features/shortcuts/registry";
import { stepZoom } from "@/features/appearance/prefs";
import { useWorkspacePersistence } from "@/features/workspace/useWorkspacePersistence";
import { refreshData } from "@/features/grid/useTableData";
import { refreshSchema } from "@/features/sidebar/useSchema";
import { WelcomeScreen } from "@/features/connections/WelcomeScreen";
import { UnsavedChangesDialog } from "@/features/grid/editing/UnsavedChangesDialog";
import { useUnsavedSync } from "@/features/grid/editing/useUnsavedSync";
import { WriteApprovalDialog } from "@/features/safety/WriteApprovalDialog";
import { useLayoutStore } from "@/stores/layout";
import { usePaletteStore } from "@/stores/palette";
import { useSessionStore } from "@/stores/session";
import { useShortcuts } from "@/stores/shortcuts";

// What only a connected window needs is loaded when the first connection opens, so the welcome
// screen starts without the sidebar, the editor, the grid and the palette.
const Sidebar = lazy(() =>
  import("@/components/layout/Sidebar").then((m) => ({ default: m.Sidebar })),
);
const ConnectedView = lazy(() =>
  import("@/features/connections/ConnectedView").then((m) => ({ default: m.ConnectedView })),
);
const CommandPalette = lazy(() =>
  import("@/features/palette/CommandPalette").then((m) => ({ default: m.CommandPalette })),
);
const ShortcutsDialog = lazy(() =>
  import("@/features/shortcuts/ShortcutsDialog").then((m) => ({ default: m.ShortcutsDialog })),
);

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

  // Find and Export stand for a few commands and ask them in turn: the sidebar when the focus is
  // there, else the table; the table or the query in front.
  useShortcut("edit.find", () => runFirst(["sidebar.filter", "table.filter"]), {
    enabled: connected,
  });
  useShortcut("file.export", () => runFirst(["table.export", "query.export"]), {
    enabled: connected,
  });

  // File and View.
  useShortcut("app.newConnection", async () => {
    // A connection that is open is closed first (the welcome screen is where connections are made).
    if (
      useSessionStore.getState().activeConnectionId &&
      !(await useSessionStore.getState().disconnect())
    ) {
      return;
    }
    useWelcome.getState().requestNewConnection();
  });
  useShortcut(
    "file.import",
    () =>
      useImportDialog
        .getState()
        .open({ schema: useBrowserStore.getState().schema ?? "public", table: null }),
    { enabled: connected },
  );
  useShortcut("file.backup", () => useBackupDialog.getState().show("backup"), {
    enabled: connected,
  });
  useShortcut("file.restore", () => useBackupDialog.getState().show("restore"), {
    enabled: connected,
  });
  useShortcut("app.theme.system", () => useAppearance.getState().set({ mode: "system" }));
  useShortcut("app.theme.light", () => useAppearance.getState().set({ mode: "light" }));
  useShortcut("app.theme.dark", () => useAppearance.getState().set({ mode: "dark" }));
  useShortcut("view.zoomIn", () =>
    useAppearance.getState().set({ zoom: stepZoom(useAppearance.getState().zoom, 1) }),
  );
  useShortcut("view.zoomOut", () =>
    useAppearance.getState().set({ zoom: stepZoom(useAppearance.getState().zoom, -1) }),
  );
  useShortcut("view.zoomReset", () => useAppearance.getState().set({ zoom: 1 }));
  // AngkorDB ▸ Check for Updates, and the check a few seconds after launch.
  useShortcut("app.checkUpdates", () => void useUpdates.getState().check({ manual: true }));
  useLaunchUpdateCheck();
  useNativeMenu();
  useDockOpen();
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
            {!sidebarCollapsed && (
              <Suspense fallback={null}>
                <Sidebar />
              </Suspense>
            )}
            <main className="flex min-w-0 flex-1 flex-col">
              <TabBar />
              <Suspense fallback={null}>
                <ConnectedView />
              </Suspense>
            </main>
          </>
        ) : (
          <main className="min-w-0 flex-1">
            <WelcomeScreen />
          </main>
        )}
      </div>

      {activeId && (
        <Suspense fallback={null}>
          <CommandPalette connectionId={activeId} />
        </Suspense>
      )}
      <UnsavedChangesDialog />
      <WriteApprovalDialog />
      <Suspense fallback={null}>
        <ShortcutsDialog />
      </Suspense>
      <QuitConfirmDialog />
      <UpdateBanner />
      <FileDropZone />
      <StatusBar />
    </div>
  );
}
