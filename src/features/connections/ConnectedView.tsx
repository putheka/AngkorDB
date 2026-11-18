import { PlugZapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ColorDot } from "@/features/connections/ColorDot";
import { describeConnection } from "@/features/connections/form";
import { useConnections } from "@/features/connections/useConnections";
import { useSessionStore } from "@/stores/session";

/** Placeholder until the schema browser arrives (ANG-15, ANG-17). */
export function ConnectedView() {
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const serverVersion = useSessionStore((s) => s.serverVersion);
  const disconnect = useSessionStore((s) => s.disconnect);
  const { data: connections = [] } = useConnections();
  const active = connections.find((c) => c.id === activeId);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      {active && (
        <>
          <p className="flex items-center gap-2 text-lg font-medium">
            <ColorDot color={active.color} /> {active.name}
          </p>
          <p className="text-sm text-muted-foreground">
            {describeConnection(active)} · PostgreSQL {serverVersion}
          </p>
        </>
      )}
      <p className="text-sm text-muted-foreground">Tables and schemas will appear here soon.</p>
      <Button variant="outline" onClick={() => void disconnect()}>
        <PlugZapIcon /> Disconnect
      </Button>
    </div>
  );
}
