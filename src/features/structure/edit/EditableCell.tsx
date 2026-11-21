import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

interface Props {
  /** What the cell holds now (the staged value, if there is one). */
  value: string;
  /** What to show when it is empty. */
  placeholder?: string;
  label: string;
  mono?: boolean;
  /** The cell differs from what is saved. */
  changed?: boolean;
  disabled?: boolean;
  onCommit: (text: string) => void;
  className?: string;
}

/**
 * Text that turns into an input when clicked. Enter or leaving it keeps the edit, Esc drops it.
 * Nothing is saved here: the parent stages the value.
 */
export function EditableCell({
  value,
  placeholder = "",
  label,
  mono,
  changed,
  disabled,
  onCommit,
  className,
}: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (draft !== null) {
      input.current?.focus();
      input.current?.select();
    }
    // Only when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft === null]);

  const finish = (keep: boolean) => {
    if (keep && draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
  };

  if (draft !== null) {
    return (
      <input
        ref={input}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        className={cn(
          "w-full min-w-24 rounded border border-ring bg-background px-1.5 py-0.5 outline-none",
          mono && "font-mono",
        )}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={`${label}: ${value || "empty"}. Edit`}
      disabled={disabled}
      onClick={() => setDraft(value)}
      className={cn(
        "block w-full min-w-16 rounded px-1.5 py-0.5 text-left break-all enabled:hover:bg-accent/60",
        mono && "font-mono",
        changed && "bg-amber-500/15",
        !value && "text-muted-foreground",
        className,
      )}
    >
      {value || placeholder || " "}
    </button>
  );
}
