import { cn } from "@/lib/utils";

/** Pick columns by clicking their names; the order they are picked in is the order they get. */
export function ColumnPicker({
  label,
  options,
  value,
  onChange,
  empty = "There are no columns to pick.",
}: {
  label: string;
  options: readonly string[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  empty?: string;
}) {
  const toggle = (name: string) =>
    onChange(value.includes(name) ? value.filter((v) => v !== name) : [...value, name]);
  if (options.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((name) => {
        const position = value.indexOf(name);
        const picked = position !== -1;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={picked}
            onClick={() => toggle(name)}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs",
              picked
                ? "border-ring bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50",
            )}
          >
            {picked && (
              <span className="rounded-full bg-foreground px-1 text-[10px] text-background">
                {position + 1}
              </span>
            )}
            {name}
          </button>
        );
      })}
    </div>
  );
}
