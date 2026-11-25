import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  OPERATORS,
  addDraftAfter,
  apply,
  arityOf,
  changeOperator,
  clearAll,
  isDirty,
  removeDraft,
  updateDraft,
  type FilterDraft,
  type FilterState,
} from "@/features/grid/filters";
import { cn } from "@/lib/utils";

export interface FilterColumn {
  name: string;
  typeName: string;
}

export interface FilterBarProps {
  columns: FilterColumn[];
  state: FilterState;
  /** The user typed or picked something; nothing is applied yet. */
  onChange: (state: FilterState) => void;
  /** The user pressed Apply or Enter; the rows should be fetched again. */
  onApply: (state: FilterState) => void;
  onClose: () => void;
  /** Bumped by the parent to put the cursor in the first box (⌘F). */
  focusToken: number;
}

/** A hint for what to type, from the column's type. */
function placeholderFor(typeName: string): string {
  if (typeName === "boolean") return "true or false";
  if (/^(timestamp|date)/.test(typeName)) return "2026-01-31 or 2026-01-31 08:00";
  if (/^(uuid)/.test(typeName)) return "uuid";
  return "value";
}

/**
 * Conditions combined with AND, or one raw `WHERE`. Nothing reaches the server until Apply (or
 * Enter), so a half-typed row never costs a query. Values are text, cast by the server to the
 * column's type.
 */
export function FilterBar({
  columns,
  state,
  onChange,
  onApply,
  onClose,
  focusToken,
}: FilterBarProps) {
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const firstColumn = columns[0]?.name ?? "";

  useEffect(() => {
    if (focusToken === 0) return;
    root.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [focusToken]);

  const edit = (next: FilterState) => {
    setError(null);
    onChange(next);
  };

  const submit = () => {
    const result = apply(state);
    setError(result.error);
    if (!result.error) onApply(result.state);
  };

  const clear = () => {
    setError(null);
    onApply(clearAll(state, firstColumn));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Menus (the column and operator pickers) render outside the bar but their key presses
    // still bubble here: Enter picks an item and Escape closes the menu, not the bar.
    if (!(e.target instanceof Node) || !root.current?.contains(e.target)) return;
    const inInput = e.target instanceof HTMLInputElement;
    if (e.key === "Enter" && !e.shiftKey && inInput) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const dirty = isDirty(state);
  const hasAnything =
    state.applied.filters.length > 0 ||
    state.applied.rawWhere !== null ||
    state.rawText.trim() !== "" ||
    state.drafts.some((d) => d.values.some((v) => v.trim() !== ""));

  return (
    <div
      ref={root}
      role="search"
      aria-label="Filter rows"
      onKeyDown={onKeyDown}
      className="flex shrink-0 flex-col gap-1.5 border-b bg-muted/30 px-2 py-2 text-xs"
    >
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="Filter mode" className="flex rounded-md border p-0.5">
          {(["conditions", "raw"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="tab"
              aria-selected={state.mode === mode}
              onClick={() => edit({ ...state, mode })}
              className={cn(
                "rounded px-2 py-0.5",
                state.mode === mode
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "conditions" ? "Conditions" : "SQL"}
            </button>
          ))}
        </div>
        {state.mode === "conditions" && (
          <span className="text-muted-foreground">All of these must match.</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="xs" variant={dirty ? "default" : "outline"} onClick={submit}>
            Apply
          </Button>
          <Button size="xs" variant="ghost" disabled={!hasAnything} onClick={clear}>
            Clear all
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Hide filter" onClick={onClose}>
            <XIcon />
          </Button>
        </div>
      </div>

      {state.mode === "raw" ? (
        <div className="flex items-center gap-2">
          <span className="font-mono text-muted-foreground">WHERE</span>
          <Input
            value={state.rawText}
            onChange={(e) => edit({ ...state, rawText: e.target.value })}
            placeholder={"status = 'active' AND balance > 100"}
            aria-label="WHERE condition"
            spellCheck={false}
            autoComplete="off"
            className="h-7 flex-1 font-mono text-xs"
          />
        </div>
      ) : (
        state.drafts.map((draft) => (
          <ConditionRow
            key={draft.id}
            draft={draft}
            columns={columns}
            onColumn={(column) => edit(updateDraft(state, draft.id, { column }))}
            onOperator={(op) => edit(changeOperator(state, draft.id, op))}
            onValues={(values) => edit(updateDraft(state, draft.id, { values }))}
            onAdd={() => edit(addDraftAfter(state, draft.id, firstColumn))}
            onRemove={() => edit(removeDraft(state, draft.id, firstColumn))}
          />
        ))
      )}

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

interface ConditionRowProps {
  draft: FilterDraft;
  columns: FilterColumn[];
  onColumn: (column: string) => void;
  onOperator: (op: FilterDraft["op"]) => void;
  onValues: (values: string[]) => void;
  onAdd: () => void;
  onRemove: () => void;
}

function ConditionRow({
  draft,
  columns,
  onColumn,
  onOperator,
  onValues,
  onAdd,
  onRemove,
}: ConditionRowProps) {
  const arity = arityOf(draft.op);
  const typeName = columns.find((c) => c.name === draft.column)?.typeName ?? "";
  const placeholder = placeholderFor(typeName);
  const setValue = (index: number, value: string) => {
    const values = [...draft.values];
    values[index] = value;
    onValues(values);
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select value={draft.column} onValueChange={onColumn}>
        <SelectTrigger size="sm" className="w-44 shrink-0" aria-label="Column">
          <SelectValue placeholder="Column" />
        </SelectTrigger>
        <SelectContent>
          {columns.map((c) => (
            <SelectItem key={c.name} value={c.name} title={c.typeName}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={draft.op} onValueChange={(op) => onOperator(op as FilterDraft["op"])}>
        <SelectTrigger size="sm" className="w-32 shrink-0" aria-label="Operator">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {OPERATORS.map((o) => (
            <SelectItem key={o.op} value={o.op}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {arity === 0 ? null : arity === 2 ? (
        <>
          <Input
            value={draft.values[0] ?? ""}
            onChange={(e) => setValue(0, e.target.value)}
            placeholder={placeholder}
            aria-label="From"
            spellCheck={false}
            autoComplete="off"
            className="h-7 min-w-0 flex-1 text-xs"
          />
          <span className="text-muted-foreground">and</span>
          <Input
            value={draft.values[1] ?? ""}
            onChange={(e) => setValue(1, e.target.value)}
            placeholder={placeholder}
            aria-label="To"
            spellCheck={false}
            autoComplete="off"
            className="h-7 min-w-0 flex-1 text-xs"
          />
        </>
      ) : (
        <Input
          value={draft.values[0] ?? ""}
          onChange={(e) => setValue(0, e.target.value)}
          placeholder={arity === "list" ? 'a, b, "c, d"' : placeholder}
          aria-label="Value"
          spellCheck={false}
          autoComplete="off"
          className="h-7 min-w-0 flex-1 text-xs"
        />
      )}
      {arity === 0 && <span className="flex-1" />}

      <Button size="icon-xs" variant="ghost" aria-label="Remove condition" onClick={onRemove}>
        <MinusIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Add condition" onClick={onAdd}>
        <PlusIcon />
      </Button>
    </div>
  );
}
