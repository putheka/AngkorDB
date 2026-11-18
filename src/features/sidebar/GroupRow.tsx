import { ChevronRightIcon } from "lucide-react";
import type { CSSProperties } from "react";

import type { TreeRow } from "@/features/sidebar/treeRows";
import { cn } from "@/lib/utils";

/** A collapsible heading: `Tables  12`. */
export function GroupRow({
  row,
  style,
  onToggle,
}: {
  row: Extract<TreeRow, { type: "group" }>;
  style: CSSProperties;
  onToggle: () => void;
}) {
  return (
    <div
      role="treeitem"
      aria-expanded={!row.collapsed}
      aria-selected={false}
      aria-level={1}
      style={style}
      onClick={onToggle}
      className="flex cursor-default items-center gap-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase select-none hover:text-foreground"
    >
      <ChevronRightIcon className={cn("size-3.5 shrink-0", !row.collapsed && "rotate-90")} />
      <span className="flex-1 truncate">{row.label}</span>
      <span className="tabular-nums">{row.count}</span>
    </div>
  );
}
