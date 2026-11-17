import { useQuery } from "@tanstack/react-query";

import { commands } from "@/lib/ipc";

/** Connection name, row count, query time. Shows app version for now (proves IPC works). */
export function StatusBar() {
  const info = useQuery({ queryKey: ["app-info"], queryFn: () => commands.appInfo() });

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t px-3 text-[11px] text-muted-foreground">
      <span>Not connected</span>
      <span>
        {info.data ? `${info.data.name} v${info.data.version}` : info.isError ? "IPC error" : "…"}
      </span>
    </footer>
  );
}
