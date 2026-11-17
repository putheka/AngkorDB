import { useLayoutStore } from "@/stores/layout";

/** Connection → schema → objects tree. Filled in by ANG-17. */
export function Sidebar() {
  const width = useLayoutStore((s) => s.sidebarWidth);
  return (
    <aside
      style={{ width }}
      className="shrink-0 border-r border-sidebar-border bg-sidebar p-3 text-sm text-sidebar-foreground/70"
    >
      Objects
    </aside>
  );
}
