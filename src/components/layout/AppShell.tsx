import { useEffect } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { StatusBar } from "@/components/layout/StatusBar";
import { TabBar } from "@/components/layout/TabBar";
import { ConnectedView } from "@/features/connections/ConnectedView";
import { WelcomeScreen } from "@/features/connections/WelcomeScreen";
import { useLayoutStore } from "@/stores/layout";
import { useSessionStore } from "@/stores/session";

/** Window layout: title bar · (welcome screen | sidebar + tabs) · status bar. */
export function AppShell() {
  const connected = useSessionStore((s) => s.activeConnectionId !== null);
  const sidebarCollapsed = useLayoutStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === "0") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  return (
    <div className="flex h-full flex-col">
      {/* Overlay title bar: leave room for the macOS traffic lights */}
      <header
        data-tauri-drag-region
        className="flex h-10 shrink-0 items-center border-b pl-20 text-xs font-medium text-muted-foreground"
      >
        AngkorDB
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
