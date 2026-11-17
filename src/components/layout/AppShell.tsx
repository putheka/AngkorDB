import { useEffect } from "react";

import { Sidebar } from "@/components/layout/Sidebar";
import { StatusBar } from "@/components/layout/StatusBar";
import { TabBar } from "@/components/layout/TabBar";
import { useLayoutStore } from "@/stores/layout";

/** Window layout: title bar · sidebar | (tab bar / main pane) · status bar. Filled in by ANG-12. */
export function AppShell() {
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
        className="flex h-10 shrink-0 items-center border-b border-neutral-200 pl-20 text-xs font-medium text-neutral-500 dark:border-neutral-800"
      >
        AngkorDB
      </header>

      <div className="flex min-h-0 flex-1">
        {!sidebarCollapsed && <Sidebar />}
        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <section className="flex flex-1 items-center justify-center text-sm text-neutral-400">
            No connection open
          </section>
        </main>
      </div>

      <StatusBar />
    </div>
  );
}
