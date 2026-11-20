import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { JsonRaw } from "@/features/grid/detail/JsonRaw";
import { JsonTree } from "@/features/grid/detail/JsonTree";
import { formatJson, stringifyJson, tryParseJson, type JsonNode } from "@/lib/json";
import { cn } from "@/lib/utils";

interface JsonEditorProps {
  /** The JSON text as it is now. */
  value: string;
  /** Called with every valid text: after each tree edit, and while typing as soon as it parses. */
  onChange: (text: string) => void;
  readOnly: boolean;
}

/**
 * Edit a json / jsonb value as a tree or as text (Raw). Whatever is shown as valid has already
 * been passed on, so there is nothing to apply; text that does not parse stays here, with the
 * error, until it is fixed. Numbers keep every digit.
 */
export function JsonEditor({ value, onChange, readOnly }: JsonEditorProps) {
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const [draft, setDraft] = useState(value);
  // A value that arrives from outside (Revert, another row) replaces what is typed here.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }

  const parsed = useMemo(() => tryParseJson(draft), [draft]);

  const apply = (text: string) => {
    setDraft(text);
    // Only a text that is passed on counts as "seen": an invalid draft must not be replaced by
    // the last valid value that the parent still holds.
    if (tryParseJson(text).ok) {
      setSeen(text);
      onChange(text);
    }
  };
  const applyNode = (node: JsonNode) => apply(stringifyJson(node));
  const reformat = (indent: number | null, spaced = true) => {
    if (parsed.ok) apply(formatJson(draft, indent, spaced));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1">
        <div role="tablist" aria-label="JSON view" className="flex rounded-md border p-0.5 text-xs">
          {(["tree", "raw"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded px-2 py-0.5",
                mode === m
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {m === "tree" ? "Tree" : "Raw"}
            </button>
          ))}
        </div>
        {!readOnly && (
          <div className="ml-auto flex gap-1">
            <Button size="xs" variant="ghost" disabled={!parsed.ok} onClick={() => reformat(2)}>
              Format
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={!parsed.ok}
              onClick={() => reformat(null, false)}
            >
              Minify
            </Button>
          </div>
        )}
      </div>

      {mode === "tree" ? (
        parsed.ok ? (
          <div className="max-h-80 overflow-auto rounded-md border bg-muted/20 p-1.5">
            <JsonTree node={parsed.node} onChange={applyNode} readOnly={readOnly} />
          </div>
        ) : (
          <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
            The text is not valid JSON, so there is no tree. Fix it in Raw.
          </p>
        )
      ) : (
        <div className="h-60 overflow-hidden rounded-md border">
          <JsonRaw text={draft} onChange={apply} readOnly={readOnly} />
        </div>
      )}

      {parsed.ok ? (
        <p className="text-xs text-muted-foreground">Valid JSON</p>
      ) : (
        <p role="alert" className="text-xs text-destructive">
          Line {parsed.error.line}, column {parsed.error.column}: {parsed.error.message}. The value
          stays as it was until this is valid.
        </p>
      )}
    </div>
  );
}
