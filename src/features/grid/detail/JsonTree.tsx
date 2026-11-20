import { ChevronDownIcon, ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  addChild,
  childCount,
  emptyNode,
  getAt,
  isJsonNumber,
  removeAt,
  renameKey,
  replaceAt,
  type JsonNode,
  type JsonPath,
  type JsonType,
} from "@/lib/json";
import { cn } from "@/lib/utils";

const TYPES: JsonType[] = ["string", "number", "boolean", "null", "object", "array"];
/** Containers deeper than this start collapsed. */
const OPEN_DEPTH = 2;
/** Children shown at first; "show more" adds this many. */
const PAGE = 100;

const pathKey = (path: JsonPath) => path.join(".");

interface JsonTreeProps {
  node: JsonNode;
  /** Every edit makes a whole new, valid tree. */
  onChange: (node: JsonNode) => void;
  readOnly: boolean;
}

type Editing = { path: JsonPath; part: "key" | "value" } | null;

/**
 * A collapsible tree of the value. Click a value to edit it (type, then the value), click a key
 * to rename it, × removes an entry and + adds one. Numbers keep the text they were written as.
 */
export function JsonTree({ node, onChange, readOnly }: JsonTreeProps) {
  // Containers whose open/closed state differs from the default for their depth.
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Editing>(null);

  const isOpen = (path: JsonPath) => path.length < OPEN_DEPTH !== flipped.has(pathKey(path));
  const toggle = (path: JsonPath) =>
    setFlipped((current) => {
      const next = new Set(current);
      const key = pathKey(path);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const add = (path: JsonPath) => {
    const container = getAt(node, path);
    if (!container) return;
    const index = childCount(container);
    onChange(addChild(node, path, emptyNode("string"), ""));
    setFlipped((current) => {
      const next = new Set(current);
      // Make sure the container is open to show the new row.
      if (!isOpen(path)) toggleInto(next, path);
      return next;
    });
    setEditing({ path: [...path, index], part: container.type === "object" ? "key" : "value" });
  };
  const toggleInto = (set: Set<string>, path: JsonPath) => {
    const key = pathKey(path);
    if (!set.delete(key)) set.add(key);
  };

  // A plain function, not a component: a component defined here would be a new type on every
  // render and lose the focus of the box being typed in.
  const rows = (
    value: JsonNode,
    path: JsonPath,
    label: string | null,
    kind: "key" | "index",
  ): ReactNode => {
    const container = value.type === "object" || value.type === "array";
    const open = container && isOpen(path);
    const editingValue =
      editing && pathKey(editing.path) === pathKey(path) && editing.part === "value";
    const editingKey = editing && pathKey(editing.path) === pathKey(path) && editing.part === "key";
    const count = childCount(value);
    const limit = shown[pathKey(path)] ?? PAGE;

    return (
      <div key={pathKey(path)}>
        <div className="group flex items-start gap-1 py-px">
          {container ? (
            <button
              type="button"
              aria-label={open ? "Collapse" : "Expand"}
              onClick={() => toggle(path)}
              className="mt-0.5 shrink-0 text-muted-foreground"
            >
              {open ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
            </button>
          ) : (
            <span className="size-3 shrink-0" />
          )}

          {label !== null &&
            (editingKey ? (
              <InlineText
                initial={label}
                label="Key"
                onCommit={(key) => {
                  onChange(renameKey(node, path, key));
                  setEditing({ path, part: "value" });
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <button
                type="button"
                disabled={readOnly || kind === "index"}
                onClick={() => setEditing({ path, part: "key" })}
                className={cn(
                  "shrink-0 text-left",
                  kind === "key" ? "text-(--sql-type)" : "text-muted-foreground",
                )}
              >
                {kind === "key" ? JSON.stringify(label) : label}
                <span className="text-muted-foreground">:</span>
              </button>
            ))}

          {editingValue ? (
            <ValueEditor
              value={value}
              onCommit={(next) => {
                onChange(replaceAt(node, path, next));
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : container ? (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => setEditing({ path, part: "value" })}
              className="text-muted-foreground"
            >
              {value.type === "object" ? "{" : "["}
              {!open &&
                ` … ${count} ${value.type === "object" ? (count === 1 ? "key" : "keys") : count === 1 ? "item" : "items"} `}
              {!open && (value.type === "object" ? "}" : "]")}
              {open && count === 0 && (value.type === "object" ? "}" : "]")}
            </button>
          ) : (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => setEditing({ path, part: "value" })}
              className="min-w-0 text-left break-all"
            >
              <Leaf value={value} />
            </button>
          )}

          {!readOnly && path.length > 0 && !editingValue && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove"
              onClick={() => onChange(removeAt(node, path))}
              className="ml-auto size-4 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <XIcon className="size-3" />
            </Button>
          )}
        </div>

        {open && container && (
          <div className="ml-2 border-l pl-2">
            {value.type === "object"
              ? value.entries
                  .slice(0, limit)
                  .map((entry, i) => rows(entry.value, [...path, i], entry.key, "key"))
              : value.items
                  .slice(0, limit)
                  .map((item, i) => rows(item, [...path, i], String(i), "index"))}
            {count > limit && (
              <button
                type="button"
                onClick={() => setShown((s) => ({ ...s, [pathKey(path)]: limit + PAGE }))}
                className="py-0.5 pl-4 text-muted-foreground hover:text-foreground"
              >
                … {count - limit} more
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={() => add(path)}
                className="flex items-center gap-1 py-0.5 pl-4 text-muted-foreground hover:text-foreground"
              >
                <PlusIcon className="size-3" />
                {value.type === "object" ? "Add key" : "Add item"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div role="tree" aria-label="JSON tree" className="font-mono text-xs leading-5">
      {rows(node, [], null, "index")}
    </div>
  );
}

function Leaf({ value }: { value: JsonNode }) {
  switch (value.type) {
    case "string":
      return <span className="text-(--sql-string)">{JSON.stringify(value.value)}</span>;
    case "number":
      return <span className="text-(--sql-number)">{value.raw}</span>;
    case "boolean":
      return <span className="text-(--sql-number)">{String(value.value)}</span>;
    case "null":
      return <span className="text-(--sql-number) italic">null</span>;
    default:
      return null;
  }
}

/** A one-line text box that saves on Enter or when focus leaves, and cancels on Esc. */
function InlineText({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) onCommit(text);
    else onCancel();
  };
  return (
    <input
      autoFocus
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      className="h-5 min-w-16 rounded border bg-background px-1 font-mono text-xs outline-none focus-visible:border-ring"
    />
  );
}

/** Change a value: pick its type, then type the value. Enter saves, Esc cancels. */
function ValueEditor({
  value,
  onCommit,
  onCancel,
}: {
  value: JsonNode;
  onCommit: (next: JsonNode) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<JsonType>(value.type);
  const [text, setText] = useState(
    value.type === "string" ? value.value : value.type === "number" ? value.raw : "",
  );
  const [flag, setFlag] = useState(value.type === "boolean" ? value.value : false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const done = useRef(false);

  const build = (): JsonNode | string => {
    switch (type) {
      case "string":
        return { type, value: text };
      case "number":
        return isJsonNumber(text.trim()) ? { type, raw: text.trim() } : "Not a JSON number";
      case "boolean":
        return { type, value: flag };
      case "null":
        return { type };
      default:
        // Staying an object or array keeps what is in it.
        return value.type === type ? value : emptyNode(type);
    }
  };
  const save = () => {
    const next = build();
    if (typeof next === "string") return setError(next);
    if (done.current) return;
    done.current = true;
    onCommit(next);
  };
  const cancel = () => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div
      ref={root}
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && root.current?.contains(e.relatedTarget)) return;
        // Clicking away saves a value that is valid, and drops one that is not.
        const next = build();
        if (typeof next === "string") cancel();
        else save();
      }}
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
    >
      <select
        aria-label="Type"
        value={type}
        onChange={(e) => {
          setType(e.target.value as JsonType);
          setError(null);
        }}
        className="h-5 rounded border bg-background px-0.5 text-xs"
      >
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {(type === "string" || type === "number") && (
        <input
          autoFocus
          aria-label="Value"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onFocus={(e) => e.currentTarget.select()}
          className="h-5 min-w-24 flex-1 rounded border bg-background px-1 font-mono text-xs outline-none focus-visible:border-ring"
        />
      )}
      {type === "boolean" && (
        <select
          autoFocus
          aria-label="Value"
          value={String(flag)}
          onChange={(e) => setFlag(e.target.value === "true")}
          className="h-5 rounded border bg-background px-0.5 text-xs"
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
