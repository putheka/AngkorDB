import type { ColorTag } from "@/bindings";
import { cn } from "@/lib/utils";

const FILL: Record<ColorTag, string> = {
  none: "border border-muted-foreground/40",
  green: "bg-emerald-500",
  yellow: "bg-amber-400",
  red: "bg-red-500",
};

export function ColorDot({ color, className }: { color: ColorTag; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2.5 shrink-0 rounded-full", FILL[color], className)}
    />
  );
}
