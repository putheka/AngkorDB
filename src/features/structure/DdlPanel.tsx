import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { TableStructure } from "@/bindings";
import { Button } from "@/components/ui/button";
import { SqlText } from "@/features/query/SqlText";

/** The statements that create the table again, with or without what they need first. */
export function DdlPanel({ structure }: { structure: TableStructure }) {
  const needs = structure.prerequisites.trim() !== "";
  const [withNeeds, setWithNeeds] = useState(true);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const text = needs && withNeeds ? `${structure.prerequisites}\n${structure.ddl}` : structure.ddl;
  const copy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-3 py-1.5 text-xs">
        {needs && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={withNeeds}
              onChange={(e) => setWithNeeds(e.target.checked)}
            />
            Include what it needs first (types, sequences, functions)
          </label>
        )}
        <span className="text-muted-foreground">
          Owner and permissions are left out. Foreign keys come last.
        </span>
        <Button size="xs" variant="outline" className="ml-auto" onClick={copy}>
          {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre
        aria-label="DDL"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto p-3 text-xs leading-relaxed select-text"
      >
        <SqlText code={text} />
      </pre>
    </div>
  );
}
