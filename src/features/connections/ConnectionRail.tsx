import { DatabaseIcon, Loader2Icon, PlusIcon, XIcon } from "lucide-react";

import type { ColorTag, ConnectionConfig } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { railLabel } from "@/features/connections/rail";
import { useConnections } from "@/features/connections/useConnections";
import { describeConnection } from "@/features/connections/form";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session";

/** The icon's colour follows the connection's colour tag (green for local, red for prod…). */
const TINT: Record<ColorTag, string> = {
  none: "text-muted-foreground",
  green: "text-emerald-500",
  yellow: "text-amber-400",
  red: "text-red-500",
};

/**
 * The connections open in this window, one icon each down the left edge, and "+" to open another.
 * Clicking one brings it to the front with its own tabs; the others keep running.
 */
export function ConnectionRail() {
  const openIds = useSessionStore((s) => s.openIds);
  const activeId = useSessionStore((s) => s.activeConnectionId);
  const connectingId = useSessionStore((s) => s.connectingId);
  const { data: connections = [] } = useConnections();
  const open = openIds
    .map((id) => connections.find((c) => c.id === id))
    .filter((c): c is ConnectionConfig => c !== undefined);

  return (
    <nav
      aria-label="Open connections"
      className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-sidebar-border bg-sidebar px-1.5 py-2"
    >
      {open.map((connection) => (
        <RailItem
          key={connection.id}
          connection={connection}
          front={connection.id === activeId}
          busy={connectingId === connection.id}
        />
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open another connection"
            aria-pressed={activeId === null}
            onClick={() => void useSessionStore.getState().showConnections()}
            className={cn("mt-1", activeId === null && "bg-accent")}
          >
            <PlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open another connection</TooltipContent>
      </Tooltip>
    </nav>
  );
}

function RailItem({
  connection,
  front,
  busy,
}: {
  connection: ConnectionConfig;
  front: boolean;
  busy: boolean;
}) {
  const close = () => void useSessionStore.getState().closeConnection(connection.id);
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <div className="group relative w-full">
              <button
                type="button"
                aria-label={connection.name}
                aria-current={front ? "true" : undefined}
                onClick={() => void useSessionStore.getState().activate(connection.id)}
                className={cn(
                  "flex w-full flex-col items-center gap-1 rounded-lg px-1 py-2 outline-offset-[-2px] transition-colors hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring",
                  front && "bg-accent",
                )}
              >
                {busy ? (
                  <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
                ) : (
                  <DatabaseIcon className={cn("size-6", TINT[connection.color])} />
                )}
                <span
                  className={cn(
                    "w-full truncate text-center text-[11px] leading-tight",
                    front ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {railLabel(connection.name)}
                </span>
              </button>
              <button
                type="button"
                aria-label={`Close ${connection.name}`}
                onClick={close}
                className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/80 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="right">
          <span className="block font-medium">{connection.name}</span>
          <span className="block text-xs opacity-80">{describeConnection(connection)}</span>
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onSelect={close}>Close connection</ContextMenuItem>
        <ContextMenuItem onSelect={() => void commands.openWindow(null, false)}>
          New Window
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
