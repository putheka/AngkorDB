import { useQuery } from "@tanstack/react-query";

import { ColorDot } from "@/features/connections/ColorDot";
import { useConnections } from "@/features/connections/useConnections";
import { commands } from "@/lib/ipc";
import { useSessionStore } from "@/stores/session";

/** Open connection, server version, app version. */
export function StatusBar() {
  const info = useQuery({ queryKey: ["app-info"], queryFn: () => commands.appInfo() });
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const serverVersion = useSessionStore((s) => s.serverVersion);
  const { data: connections = [] } = useConnections();
  const active = connections.find((c) => c.id === activeId);

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between border-t px-3 text-[11px] text-muted-foreground">
      {active ? (
        <span className="flex items-center gap-1.5">
          <ColorDot color={active.color} className="size-2" />
          {active.name} · PostgreSQL {serverVersion}
        </span>
      ) : (
        <span>Not connected</span>
      )}
      <span>
        {info.data ? `${info.data.name} v${info.data.version}` : info.isError ? "IPC error" : "…"}
      </span>
    </footer>
  );
}
