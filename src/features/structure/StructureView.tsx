import { useQuery } from "@tanstack/react-query";

import type { TableStructure } from "@/bindings";
import { Button } from "@/components/ui/button";
import { ColumnsTable } from "@/features/structure/ColumnsTable";
import { DdlPanel } from "@/features/structure/DdlPanel";
import { InfoPanel } from "@/features/structure/InfoPanel";
import { ConstraintsTable, IndexesTable, TriggersTable } from "@/features/structure/ObjectTables";
import { SECTION_LABELS, SECTIONS, type Section } from "@/features/structure/sections";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** How many things each section has, for the number next to its name. */
function counts(s: TableStructure): Partial<Record<Section, number>> {
  return {
    columns: s.columns.length,
    indexes: s.indexes.length,
    constraints: s.constraints.length,
    triggers: s.triggers.length,
  };
}

interface Props {
  connectionId: string;
  schema: string;
  table: string;
  section: Section;
  onSection: (section: Section) => void;
}

/** How a table, view or materialized view is built: columns, indexes, constraints, triggers, info, DDL. */
export function StructureView({ connectionId, schema, table, section, onSection }: Props) {
  // Under "schema" so that ⌘R (reload the schema) refreshes it too.
  const structure = useQuery({
    queryKey: ["schema", connectionId, "structure", schema, table],
    queryFn: () => commands.tableStructure(connectionId, schema, table),
  });

  if (structure.isPending) {
    return <p className="p-6 text-center text-sm text-muted-foreground">Loading…</p>;
  }
  if (structure.isError) {
    return (
      <div role="alert" className="flex flex-col items-center gap-2 p-6 text-center text-sm">
        <p className="font-medium text-destructive">{errorMessage(structure.error)}</p>
        <Button variant="outline" size="sm" onClick={() => void structure.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const data = structure.data;
  const number = counts(data);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div role="tablist" aria-label="Structure" className="flex shrink-0 gap-1 border-b px-2 py-1">
        {SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            onClick={() => onSection(id)}
            className={cn(
              "flex items-center rounded-md border px-2 py-0.5 text-xs",
              section === id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {SECTION_LABELS[id]}
            {number[id] !== undefined && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                {number[id]}
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {section === "columns" && <ColumnsTable structure={data} />}
        {section === "indexes" && <IndexesTable structure={data} />}
        {section === "constraints" && <ConstraintsTable structure={data} />}
        {section === "triggers" && <TriggersTable structure={data} />}
        {section === "info" && <InfoPanel structure={data} />}
        {section === "ddl" && <DdlPanel structure={data} />}
      </div>
    </div>
  );
}
