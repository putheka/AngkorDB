import {
  EyeIcon,
  HashIcon,
  LayersIcon,
  ListIcon,
  SquareFunctionIcon,
  TableIcon,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import type { ObjectKind } from "@/bindings";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { isOpenable, type TreeRow } from "@/features/sidebar/treeRows";
import { formatCompact, formatRowCount } from "@/lib/format";
import { qualifiedName } from "@/lib/sql";
import { cn } from "@/lib/utils";

const ICONS: Record<ObjectKind, LucideIcon> = {
  table: TableIcon,
  partitionedTable: TableIcon,
  foreignTable: TableIcon,
  view: EyeIcon,
  materializedView: LayersIcon,
  function: SquareFunctionIcon,
  procedure: SquareFunctionIcon,
  sequence: HashIcon,
  enumType: ListIcon,
};

/** The name with the characters the filter matched in bold. */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return text;
  const hit = new Set(indices);
  return Array.from(text, (char, i) =>
    hit.has(i) ? (
      <b key={i} className="font-semibold text-foreground">
        {char}
      </b>
    ) : (
      char
    ),
  );
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

interface ObjectRowProps {
  row: Extract<TreeRow, { type: "object" }>;
  style: CSSProperties;
  /** Its tab is the one in front. */
  isActive: boolean;
  /** The keyboard cursor is here. */
  isCursor: boolean;
  onOpen: () => void;
}

export function ObjectRow({ row, style, isActive, isCursor, onOpen }: ObjectRowProps) {
  const { object, indices } = row;
  const Icon = ICONS[object.kind];
  const openable = isOpenable(object.kind);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="treeitem"
          aria-level={2}
          aria-selected={isActive}
          style={style}
          onClick={onOpen}
          title={object.detail ? `${object.name}${object.detail}` : undefined}
          className={cn(
            "flex cursor-default items-center gap-2 pr-2 pl-5 text-sm select-none hover:bg-sidebar-accent/60",
            isCursor && "bg-sidebar-accent/60",
            isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
          )}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate">
            <Highlighted text={object.name} indices={indices} />
            {object.detail && (
              <span className="ml-1 text-xs text-muted-foreground">{object.detail}</span>
            )}
          </span>
          {object.rowEstimate !== null && (
            <span
              className="ml-auto shrink-0 text-[11px] text-muted-foreground tabular-nums"
              title={formatRowCount(object.rowEstimate, false)}
            >
              {formatCompact(object.rowEstimate)}
            </span>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {openable && <ContextMenuItem onSelect={onOpen}>Open</ContextMenuItem>}
        <ContextMenuItem onSelect={() => copy(object.name)}>Copy name</ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(qualifiedName(object.schema, object.name))}>
          Copy as schema.name
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* Filled in by the structure and export work (M2, M4). */}
        <ContextMenuItem disabled>Export…</ContextMenuItem>
        <ContextMenuItem disabled>Truncate…</ContextMenuItem>
        <ContextMenuItem variant="destructive" disabled>
          Drop…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
