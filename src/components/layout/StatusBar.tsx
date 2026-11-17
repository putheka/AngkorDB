import { useQuery } from "@tanstack/react-query";

import { ipc } from "@/lib/ipc";

/** Connection name, row count, query time. Shows app version for now (proves IPC works). */
export function StatusBar() {
  const info = useQuery({ queryKey: ["app-info"], queryFn: ipc.appInfo });

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t border-neutral-200 px-3 text-[11px] text-neutral-500 dark:border-neutral-800">
      <span>Not connected</span>
      <span>
        {info.data ? `${info.data.name} v${info.data.version}` : info.isError ? "IPC error" : "…"}
      </span>
    </footer>
  );
}
