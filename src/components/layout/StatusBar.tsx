import { useQuery } from "@tanstack/react-query";

import type { SafeMode } from "@/bindings";
import { ColorDot } from "@/features/connections/ColorDot";
import { SAFE_MODE_INFO } from "@/features/connections/safeMode";
import { useConnections } from "@/features/connections/useConnections";
import { formatDuration, formatRowCount } from "@/lib/format";
import { commands } from "@/lib/ipc";
import { useSessionStore } from "@/stores/session";
import { useStatusStore } from "@/stores/status";

/** What the connection does about writes. Quiet when it allows them. */
function SafeModeLabel({ mode }: { mode: SafeMode }) {
  const { icon: Icon, label } = SAFE_MODE_INFO[mode];
  return (
    <span
      title={`Safe mode: ${label}`}
      className={
        mode === "off"
          ? "flex shrink-0 items-center gap-1 pl-2 opacity-60"
          : "flex shrink-0 items-center gap-1 pl-2 font-medium text-foreground"
      }
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}

/** Left: open connection. Right: rows and timing of the tab in front, then the app version. */
export function StatusBar() {
  const info = useQuery({ queryKey: ["app-info"], queryFn: () => commands.appInfo() });
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const serverVersion = useSessionStore((s) => s.serverVersion);
  const rowCount = useStatusStore((s) => s.rowCount);
  const queryMs = useStatusStore((s) => s.queryMs);
  const { data: connections = [] } = useConnections();
  const active = connections.find((c) => c.id === activeId);
  // Asking also checks the connection when it has been idle, and replaces it if it was lost
  // (the laptop slept, the network changed): it is already back when the next query runs.
  const health = useQuery({
    queryKey: ["connection-health", activeId],
    queryFn: () => commands.connectionHealth(activeId ?? ""),
    enabled: activeId !== null,
    refetchInterval: 5000,
    refetchIntervalInBackground: true,
    retry: false,
  });

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-4 border-t px-3 text-[11px] text-muted-foreground">
      {active ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <ColorDot color={active.color} className="size-2" />
          <span className="truncate">
            {active.name} · PostgreSQL {serverVersion}
          </span>
          <SafeModeLabel mode={active.safeMode} />
          {health.data?.reconnecting && (
            <span
              role="status"
              className="flex shrink-0 items-center gap-1 pl-2 font-medium text-amber-600 dark:text-amber-400"
              title="The connection was lost. A new one is being made."
            >
              <span className="size-1.5 animate-pulse rounded-full bg-current" />
              Reconnecting…
            </span>
          )}
          {!health.data?.reconnecting && (health.data?.reconnects ?? 0) > 0 && (
            <span
              className="shrink-0 pl-2 opacity-60"
              title="The connection was lost and made again without you doing anything."
            >
              Reconnected
              {(health.data?.reconnects ?? 0) > 1 ? ` ×${health.data?.reconnects}` : ""}
            </span>
          )}
        </span>
      ) : (
        <span>Not connected</span>
      )}
      <span className="flex shrink-0 items-center gap-3 tabular-nums">
        {rowCount && <span>{formatRowCount(rowCount.count, rowCount.exact)}</span>}
        {queryMs !== null && <span>{formatDuration(queryMs)}</span>}
        <span>
          {info.data ? `${info.data.name} v${info.data.version}` : info.isError ? "IPC error" : "…"}
        </span>
      </span>
    </footer>
  );
}
