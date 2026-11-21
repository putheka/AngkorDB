import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A plain, selectable table for the Structure view. */
export function Table({ label, children }: { label: string; children: ReactNode }) {
  return (
    <table aria-label={label} className="w-full border-collapse text-xs select-text">
      {children}
    </table>
  );
}

export function Th({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <th
      scope="col"
      className={cn(
        "sticky top-0 z-10 border-b bg-background px-2 py-1 text-left font-medium text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  );
}

/** What a section says when it has nothing in it. */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

/** A small label next to a name: `unique`, `deferrable`, `not validated`, … */
export function Badge({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <span
      className={cn(
        "mr-1 rounded-full px-1.5 py-px text-[10px]",
        tone === "warn" ? "bg-amber-500/15 text-amber-700 dark:text-amber-400" : "bg-muted",
      )}
    >
      {children}
    </span>
  );
}
