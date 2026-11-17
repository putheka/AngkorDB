import { PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Table + query tabs. Filled in by ANG-13. */
export function TabBar() {
  return (
    <nav className="flex h-9 shrink-0 items-center justify-between border-b px-2 text-xs text-muted-foreground">
      <span>No tabs</span>
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
