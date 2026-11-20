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

  return (
    <footer className="flex h-6 shrink-0 items-center justify-between gap-4 border-t px-3 text-[11px] text-muted-foreground">
      {active ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <ColorDot color={active.color} className="size-2" />
          <span className="truncate">
            {active.name} · PostgreSQL {serverVersion}
          </span>
          <SafeModeLabel mode={active.safeMode} />
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
