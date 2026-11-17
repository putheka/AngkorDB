import { useLayoutStore } from "@/stores/layout";

/** Connection → schema → objects tree. Filled in by ANG-17. */
export function Sidebar() {
  const width = useLayoutStore((s) => s.sidebarWidth);
  return (
    <aside
      style={{ width }}
      className="shrink-0 border-r border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900"
    >
      Objects
    </aside>
  );
}
