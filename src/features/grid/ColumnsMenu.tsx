import { Columns3Icon, SearchIcon } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { ResultColumn } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { matchColumns, orderedNames, withHidden, type ColumnLayout } from "@/features/grid/columns";
import { cn } from "@/lib/utils";

export interface ColumnsMenuProps {
  columns: ResultColumn[];
  layout: ColumnLayout;
  onLayoutChange: (layout: ColumnLayout) => void;
}

/** Show or hide columns: a search box, every column with its type, and show all / hide all. */
export function ColumnsMenu({ columns, layout, onLayoutChange }: ColumnsMenuProps) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const hidden = useMemo(() => new Set(layout.hidden), [layout.hidden]);
  const rows = useMemo(() => {
    const typeOf = new Map(columns.map((c) => [c.name, c.typeName]));
    const all = orderedNames(columns, layout).map((name) => ({
      name,
      typeName: typeOf.get(name) ?? "",
    }));
    return matchColumns(all, query);
  }, [columns, layout, query]);

  const hiddenCount = columns.filter((c) => hidden.has(c.name)).length;
  const searching = query.trim() !== "";
  const rowNames = rows.map((row) => row.name);
  const anyHidden = rows.some((row) => hidden.has(row.name));
  const anyShown = rows.some((row) => !hidden.has(row.name));

  const inputs = () => Array.from(list.current?.querySelectorAll("input") ?? []);

  const onSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      inputs()[0]?.focus();
    }
  };

  const onListKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = inputs();
    const at = all.findIndex((input) => input === document.activeElement);
    if (e.key === "ArrowDown") all[Math.min(at + 1, all.length - 1)]?.focus();
    else if (at <= 0) search.current?.focus();
    else all[at - 1]?.focus();
  };

  return (
    <Popover onOpenChange={(open) => !open && setQuery("")}>
      <PopoverTrigger asChild>
        <Button
          variant={hiddenCount > 0 ? "secondary" : "ghost"}
          size="xs"
          aria-label="Show or hide columns"
        >
          <Columns3Icon />
          Columns{hiddenCount > 0 && ` (${columns.length - hiddenCount}/${columns.length})`}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[22rem] gap-0 p-0">
        <div className="flex items-center gap-2 border-b px-2.5 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder="Find a column"
            aria-label="Find a column"
            spellCheck={false}
            autoComplete="off"
            className="h-5 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div
          ref={list}
          role="group"
          aria-label="Columns"
          onKeyDown={onListKeyDown}
          className="max-h-72 overflow-y-auto p-1"
        >
          {rows.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              No column matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            rows.map(({ name, typeName }) => {
              const shown = !hidden.has(name);
              return (
                <label
                  key={name}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs focus-within:bg-accent hover:bg-accent"
                >
                  <input
                    type="checkbox"
                    checked={shown}
                    onChange={() => onLayoutChange(withHidden(layout, [name], shown))}
                  />
                  <span
                    className={cn("min-w-0 flex-1 truncate", !shown && "text-muted-foreground")}
                    title={name}
                  >
                    {name}
                  </span>
                  <span
                    className="max-w-32 shrink-0 truncate font-mono text-[10px] text-muted-foreground"
                    title={typeName}
                  >
                    {typeName}
                  </span>
                </label>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t px-2.5 py-1.5 text-xs">
          <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
            {columns.length - hiddenCount} of {columns.length} shown
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={!anyHidden}
              onClick={() => onLayoutChange(withHidden(layout, rowNames, false))}
            >
              {searching ? "Show matching" : "Show all"}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={!anyShown}
              onClick={() => onLayoutChange(withHidden(layout, rowNames, true))}
            >
              {searching ? "Hide matching" : "Hide all"}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
