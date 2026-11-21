import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns3Icon,
  DownloadIcon,
  ListFilterIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";

import type { ResultColumn } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { orderedNames, type ColumnLayout } from "@/features/grid/columns";
import { PAGE_SIZES } from "@/features/grid/tableViews";
import { formatCompact } from "@/lib/format";

const number = new Intl.NumberFormat("en-US");

export interface GridFooterProps {
  page: number;
  pageSize: number;
  /** Rows on this page. */
  rowCount: number;
  hasMore: boolean;
  /** `exact: false` is the planner's guess. `null` while unknown. */
  total: { count: number; exact: boolean } | null;
  fetching: boolean;
  columns: ResultColumn[];
  layout: ColumnLayout;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  onLayoutChange: (layout: ColumnLayout) => void;
  onRefresh: () => void;
  /** Ask for the real count; shown next to an estimate, or when a filter makes it unknown. */
  onCountExactly: () => void;
  /** Conditions in force (filters, plus the raw WHERE). */
  filterCount: number;
  filterOpen: boolean;
  onToggleFilter: () => void;
  /** Export the rows of this table (what the filter matches) to a file. */
  onExport?: () => void;
  /** Add a row at the top (⌘I). Left out when the table can't be edited. */
  onAddRow?: () => void;
  /** The row details panel on the right (Space). */
  detailOpen: boolean;
  onToggleDetail: () => void;
}

/** `‹ 1–500 of ~1.2M ›`, page size, column visibility and refresh. */
export function GridFooter(props: GridFooterProps) {
  const { page, pageSize, rowCount, hasMore, total, layout, columns } = props;
  const first = page * pageSize + 1;
  const range =
    rowCount === 0 ? "No rows" : `${number.format(first)}–${number.format(first + rowCount - 1)}`;
  const totalText = total
    ? `${total.exact ? "" : "~"}${total.exact ? number.format(total.count) : formatCompact(total.count)}`
    : "";
  const hiddenCount = layout.hidden.length;

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t px-2 text-xs">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous page"
          disabled={page === 0}
          onClick={() => props.onPage(page - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-28 text-center tabular-nums">
          {range}
          {rowCount > 0 && totalText !== "" && <> of {totalText}</>}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next page"
          disabled={!hasMore}
          onClick={() => props.onPage(page + 1)}
        >
          <ChevronRightIcon />
        </Button>
        {/* A guess can be made exact; with a filter there is no guess until someone counts. */}
        {((total && !total.exact) || (!total && hasMore)) && (
          <Button variant="ghost" size="xs" onClick={props.onCountExactly}>
            {total ? "Count exactly" : "Count rows"}
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1">
        {props.onExport && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="xs" aria-label="Export" onClick={props.onExport}>
                <DownloadIcon />
                Export
              </Button>
            </TooltipTrigger>
            <TooltipContent>Save the rows to a file</TooltipContent>
          </Tooltip>
        )}
        {props.onAddRow && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="xs" aria-label="Add row" onClick={props.onAddRow}>
                <PlusIcon />
                Row
              </Button>
            </TooltipTrigger>
            <TooltipContent>Add a row (⌘I)</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={props.detailOpen ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={props.detailOpen}
              aria-label="Row details"
              onClick={props.onToggleDetail}
            >
              <PanelRightIcon />
              Details
            </Button>
          </TooltipTrigger>
          <TooltipContent>Show the selected row as a form (Space)</TooltipContent>
        </Tooltip>
        <Select value={String(pageSize)} onValueChange={(v) => props.onPageSize(Number(v))}>
          <SelectTrigger size="sm" className="h-6 gap-1 px-2 text-xs" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size} rows
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={props.filterCount > 0 || props.filterOpen ? "secondary" : "ghost"}
          size="xs"
          aria-pressed={props.filterOpen}
          aria-label="Filter rows"
          onClick={props.onToggleFilter}
        >
          <ListFilterIcon />
          Filter{props.filterCount > 0 && ` (${props.filterCount})`}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs" aria-label="Show or hide columns">
              <Columns3Icon />
              Columns{hiddenCount > 0 && ` (${columns.length - hiddenCount}/${columns.length})`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            {orderedNames(columns, layout).map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={!layout.hidden.includes(name)}
                // Stay open: people tick several columns in one go.
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(show) =>
                  props.onLayoutChange({
                    ...layout,
                    hidden: show
                      ? layout.hidden.filter((n) => n !== name)
                      : [...layout.hidden, name],
                  })
                }
              >
                {name}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={hiddenCount === 0}
              onSelect={() => props.onLayoutChange({ ...layout, hidden: [] })}
            >
              Show all
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Refresh" onClick={props.onRefresh}>
              <RefreshCwIcon className={props.fetching ? "animate-spin" : undefined} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reload rows (⌘R)</TooltipContent>
        </Tooltip>
      </div>
    </footer>
  );
}
