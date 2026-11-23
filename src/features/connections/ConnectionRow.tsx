import {
  AppWindowIcon,
  CopyIcon,
  Loader2Icon,
  PencilIcon,
  PlugIcon,
  Trash2Icon,
} from "lucide-react";

import type { ConnectionConfig } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ColorDot } from "@/features/connections/ColorDot";
import { describeConnection } from "@/features/connections/form";
import { SAFE_MODE_INFO } from "@/features/connections/safeMode";
import { cn } from "@/lib/utils";

interface ConnectionRowProps {
  connection: ConnectionConfig;
  selected: boolean;
  connecting: boolean;
  /** Another connection is being opened. */
  disabled: boolean;
  onSelect: () => void;
  onConnect: () => void;
  /** Open it in a window of its own, so what is open here stays. */
  onConnectInNewWindow: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function SafeModeIcon({ mode }: { mode: ConnectionConfig["safeMode"] }) {
  const { icon: Icon, label } = SAFE_MODE_INFO[mode];
  return <Icon className="size-3.5 text-muted-foreground" aria-label={label} />;
}

export function ConnectionRow(props: ConnectionRowProps) {
  const { connection, selected, connecting, disabled } = props;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn(
            "group flex items-center gap-1 rounded-lg pr-1.5 transition-colors hover:bg-accent/60",
            selected && "bg-accent",
          )}
        >
          <button
            type="button"
            disabled={disabled}
            onClick={props.onSelect}
            onDoubleClick={props.onConnect}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                props.onConnect();
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
          >
            <ColorDot color={connection.color} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{connection.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {describeConnection(connection)}
              </span>
            </span>
            {connection.safeMode !== "off" && <SafeModeIcon mode={connection.safeMode} />}
            {connecting && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
          </button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Edit ${connection.name}`}
            disabled={disabled}
            onClick={props.onEdit}
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          >
            <PencilIcon />
          </Button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={props.onConnect} disabled={disabled}>
          <PlugIcon /> Connect
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onConnectInNewWindow}>
          <AppWindowIcon /> Open in New Window
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onEdit}>
          <PencilIcon /> Edit…
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onDuplicate}>
          <CopyIcon /> Duplicate
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={props.onDelete}>
          <Trash2Icon /> Delete…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
