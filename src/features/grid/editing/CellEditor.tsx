import { useQuery } from "@tanstack/react-query";
import { CalendarIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { ColumnInfo } from "@/bindings";
import { Button } from "@/components/ui/button";
import type { CellValue } from "@/features/grid/editing/changes";
import {
  editorKindOf,
  normalize,
  validate,
  type EditorKind,
} from "@/features/grid/editing/editorKind";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** A rectangle in window coordinates: where the cell being edited is. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CellEditorProps {
  connectionId: string;
  column: ColumnInfo;
  /** The cell as it is now, with edits already staged. */
  current: CellValue;
  /** A key the user typed to start editing: it replaces the text instead of editing it. */
  typed?: string;
  bounds: Bounds;
  onCommit: (value: CellValue) => void;
  onCancel: () => void;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `2026-11-20`, in the user's time zone. */
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/** `2026-11-20T09:30:00+07:00`: a moment with its offset, which Postgres reads without guessing. */
function localIsoWithOffset(d: Date): string {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  return `${localDate(d)}T${localTime(d)}${sign}${hours}:${minutes}`;
}

/** The text for "now" in a temporal column. */
function nowFor(kind: EditorKind): string {
  const now = new Date();
  if (kind === "date") return localDate(now);
  if (kind === "time") return localTime(now);
  if (kind === "timestamp") return `${localDate(now)} ${localTime(now)}`;
  return localIsoWithOffset(now);
}

/** The text a native picker's value stands for. */
function fromPicker(kind: EditorKind, value: string): string {
  if (kind === "date") return value;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return kind === "timestamp"
    ? withSeconds.replace("T", " ")
    : localIsoWithOffset(new Date(withSeconds));
}

const SINGLE_LINE: EditorKind[] = [
  "integer",
  "decimal",
  "uuid",
  "date",
  "time",
  "timestamp",
  "timestamptz",
];

/**
 * The popup for editing one cell, picked by the column's type: a text box (or a taller one for
 * text and JSON), a True / False choice, a list for enums, a UUID with "Generate", dates with
 * "Now" and a picker. Every kind can also set NULL (⌘⌫) or DEFAULT. Enter saves, Esc cancels,
 * and clicking away saves when the text is valid and was changed.
 */
export function CellEditor({
  connectionId,
  column,
  current,
  typed,
  bounds,
  onCommit: commit,
  onCancel: cancel,
}: CellEditorProps) {
  const kind = editorKindOf(column);
  const root = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);

  // A user-made type is an enum when the catalog has labels for it.
  const enumQuery = useQuery({
    queryKey: ["schema", connectionId, "enum", column.typeOid],
    queryFn: () => commands.listEnumValues(connectionId, column.typeOid),
    enabled: kind === "userType",
    staleTime: 60_000,
  });
  const labels = enumQuery.data ?? [];
  const isEnum = kind === "userType" && labels.length > 0;

  const startText = current.kind === "value" ? current.text : "";
  const [text, setText] = useState(typed ?? startText);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState(() =>
    Math.max(0, labels.indexOf(current.kind === "value" ? current.text : "")),
  );
  const dirty = text !== startText;

  // Closing moves focus to the grid, which looks like "clicked away" to onBlur. Whatever
  // closes the editor first (save or cancel) is the only thing that counts.
  const finished = useRef(false);
  const onCommit = (value: CellValue) => {
    if (finished.current) return;
    finished.current = true;
    commit(value);
  };
  const onCancel = () => {
    if (finished.current) return;
    finished.current = true;
    cancel();
  };

  // Put the cursor in: all text selected when editing, at the end when a typed key started it.
  useEffect(() => {
    const field = root.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea",
    );
    field?.focus();
    if (typed === undefined) field?.select();
    else field?.setSelectionRange(typed.length, typed.length);
    // The first render only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (isEnum) root.current?.focus();
  }, [isEnum]);

  const save = (value: string) => {
    const normalized = normalize(kind, value);
    const problem = validate(kind, column.typeOid, normalized);
    if (problem) {
      setError(problem);
      return;
    }
    onCommit({ kind: "value", text: normalized });
  };

  const setNull = () => {
    if (!column.nullable) {
      setError(`${column.name} can't be NULL.`);
      return;
    }
    onCommit({ kind: "null" });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      e.preventDefault();
      setNull();
    } else if (isEnum) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setChoice((c) => (c + (e.key === "ArrowDown" ? 1 : -1) + labels.length) % labels.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const label = labels[choice];
        if (label !== undefined) onCommit({ kind: "value", text: label });
      }
    } else if (e.key === "Enter" && e.target instanceof HTMLTextAreaElement) {
      // Text: Enter saves, Shift+Enter is a new line. JSON: Enter is a new line, ⌘Enter saves.
      const saves = kind === "json" ? e.metaKey || e.ctrlKey : !e.shiftKey;
      if (saves) {
        e.preventDefault();
        save(text);
      }
    } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      e.preventDefault();
      save(text);
    }
  };

  // Clicking outside saves a changed, valid text. Anything else just closes.
  const onBlur = (e: React.FocusEvent) => {
    if (e.relatedTarget instanceof Node && root.current?.contains(e.relatedTarget)) return;
    if (isEnum || kind === "bool") return onCancel();
    const normalized = normalize(kind, text);
    if (dirty && validate(kind, column.typeOid, normalized) === null) {
      onCommit({ kind: "value", text: normalized });
    } else onCancel();
  };

  // Keep the popup on screen.
  const width = Math.max(bounds.width, 280);
  const left = Math.min(bounds.x, Math.max(8, window.innerWidth - width - 8));
  const top = Math.min(bounds.y, Math.max(8, window.innerHeight - 280));

  const multiline = !SINGLE_LINE.includes(kind);
  const hint = isEnum
    ? "↑↓ choose · ↵ select · esc cancel"
    : kind === "bool"
      ? "esc cancel"
      : kind === "json"
        ? "⌘↵ save · esc cancel"
        : multiline && !isEnum
          ? "↵ save · ⇧↵ new line · esc cancel"
          : "↵ save · esc cancel";

  return (
    <div
      ref={root}
      role="dialog"
      data-cell-editor=""
      aria-label={`Edit ${column.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      style={{ left, top, width }}
      className="fixed z-50 flex flex-col gap-2 rounded-lg border bg-popover p-2 text-popover-foreground shadow-lg outline-none select-text"
    >
      <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate font-medium text-foreground">{column.name}</span>
        <span className="shrink-0">{column.typeName}</span>
      </div>

      {kind === "bool" ? (
        <div className="flex gap-1.5">
          {(["true", "false"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={current.kind === "value" && current.text === option ? "default" : "outline"}
              className="flex-1"
              onClick={() => onCommit({ kind: "value", text: option })}
              autoFocus={option === "true"}
            >
              {option === "true" ? "True" : "False"}
            </Button>
          ))}
        </div>
      ) : isEnum ? (
        <ul role="listbox" aria-label={column.name} className="max-h-56 overflow-y-auto">
          {labels.map((label, i) => (
            <li
              key={label}
              role="option"
              aria-selected={i === choice}
              onMouseEnter={() => setChoice(i)}
              onClick={() => onCommit({ kind: "value", text: label })}
              className={cn(
                "flex cursor-default items-center justify-between rounded-md px-2 py-1 text-sm",
                i === choice && "bg-accent text-accent-foreground",
              )}
            >
              {label}
              {current.kind === "value" && current.text === label && (
                <span className="text-[11px] text-muted-foreground">current</span>
              )}
            </li>
          ))}
        </ul>
      ) : multiline ? (
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          rows={Math.min(Math.max(text.split("\n").length, 2), 10)}
          spellCheck={false}
          placeholder={
            current.kind === "null" ? "NULL" : current.kind === "default" ? "DEFAULT" : ""
          }
          aria-label={column.name}
          className={cn(
            "w-full resize-y rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
            kind === "json" && "font-mono text-xs",
          )}
        />
      ) : (
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          spellCheck={false}
          autoComplete="off"
          placeholder={
            current.kind === "null" ? "NULL" : current.kind === "default" ? "DEFAULT" : ""
          }
          aria-label={column.name}
          className={cn(
            "h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
            (kind === "integer" || kind === "decimal") && "text-right tabular-nums",
          )}
        />
      )}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1">
        {kind === "uuid" && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setText(crypto.randomUUID());
              setError(null);
            }}
          >
            Generate
          </Button>
        )}
        {(kind === "date" || kind === "time" || kind === "timestamp" || kind === "timestamptz") && (
          <>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setText(nowFor(kind));
                setError(null);
              }}
            >
              Now
            </Button>
            {kind !== "time" && (
              <>
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Pick from a calendar"
                  onClick={() => pickerRef.current?.showPicker()}
                >
                  <CalendarIcon />
                </Button>
                {/* The browser's own picker; its value is turned into text when chosen. */}
                <input
                  ref={pickerRef}
                  type={kind === "date" ? "date" : "datetime-local"}
                  step={1}
                  tabIndex={-1}
                  aria-hidden
                  className="pointer-events-none absolute size-0 opacity-0"
                  onChange={(e) => {
                    if (e.target.value) {
                      setText(fromPicker(kind, e.target.value));
                      setError(null);
                    }
                  }}
                />
              </>
            )}
          </>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={!column.nullable}
          title={column.nullable ? "Set NULL (⌘⌫)" : `${column.name} can't be NULL`}
          onClick={setNull}
        >
          Set NULL
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onCommit({ kind: "default" })}>
          Set DEFAULT
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">{hint}</span>
      </div>
    </div>
  );
}
