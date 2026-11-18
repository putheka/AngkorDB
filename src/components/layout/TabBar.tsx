import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useTabsStore } from "@/stores/tabs";

/** Open tables. Query tabs, reordering and shortcuts come with ANG-13. */
export function TabBar() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activate = useTabsStore((s) => s.activate);
  const close = useTabsStore((s) => s.close);

  return (
    <nav className="flex h-9 shrink-0 items-center justify-between border-b pr-2 text-xs">
      <div role="tablist" className="flex h-full min-w-0 items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <span className="self-center px-3 text-muted-foreground">No tabs</span>
        )}
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === activeId}
            title={`${tab.schema}.${tab.name}`}
            onClick={() => activate(tab.id)}
            className={cn(
              "group flex max-w-48 shrink-0 cursor-default items-center gap-1.5 border-r pr-1 pl-3 select-none",
              tab.id === activeId
                ? "bg-background text-foreground"
                : "bg-muted/40 text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{tab.name}</span>
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                close(tab.id);
              }}
              className="rounded p-0.5 opacity-60 hover:bg-accent hover:opacity-100"
            >
              <XIcon className="size-3" />
            </button>
          </div>
        ))}
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="New query tab" disabled>
            <PlusIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>New query tab (⌘T)</TooltipContent>
      </Tooltip>
    </nav>
  );
}
