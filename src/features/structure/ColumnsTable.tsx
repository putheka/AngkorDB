import { KeyRoundIcon, Link2Icon } from "lucide-react";

import type { StructureColumn, TableStructure } from "@/bindings";
import { Table, Empty, Th } from "@/features/structure/table";
import { useTabsStore } from "@/stores/tabs";

/** Open the table a foreign key points at. */
function follow(schema: string, table: string) {
  useTabsStore.getState().openTable({ schema, name: table, kind: "table" }, true);
}

function Extras({ column }: { column: StructureColumn }) {
  const badges: string[] = [];
  if (column.identity === "always") badges.push("identity always");
  if (column.identity === "byDefault") badges.push("identity by default");
  if (column.generated === "stored") badges.push("generated, stored");
  if (column.generated === "virtual") badges.push("generated, virtual");
  if (column.collation) badges.push(`collate ${column.collation}`);
  return badges.map((b) => (
    <span key={b} className="mr-1 rounded-full bg-muted px-1.5 py-px text-[10px]">
      {b}
    </span>
  ));
}

/** Name, type, nullability, default and comment of every column. */
export function ColumnsTable({ structure }: { structure: TableStructure }) {
  if (structure.columns.length === 0) return <Empty>This has no columns.</Empty>;
  return (
    <Table label="Columns">
      <thead>
        <tr>
          <Th className="w-10 text-right">#</Th>
          <Th>Name</Th>
          <Th>Type</Th>
          <Th className="w-16">Null</Th>
          <Th>Default</Th>
          <Th>Extra</Th>
          <Th>Comment</Th>
        </tr>
      </thead>
      <tbody>
        {structure.columns.map((column) => (
          <tr key={column.name} className="border-b border-border/50 align-top hover:bg-accent/30">
            <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">
              {column.position}
            </td>
            <td className="px-2 py-1 font-medium">
              <span className="flex items-center gap-1.5">
                {column.name}
                {column.isPrimaryKey && (
                  <KeyRoundIcon
                    aria-label="Primary key"
                    className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
                  />
                )}
                {column.foreignKeys.map((fk) => (
                  <button
                    key={`${fk.constraint}.${fk.column}`}
                    type="button"
                    title={`References ${fk.schema}.${fk.table}(${fk.column}): open it`}
                    aria-label={`References ${fk.schema}.${fk.table}`}
                    onClick={() => follow(fk.schema, fk.table)}
                    className="flex items-center gap-0.5 rounded px-1 text-[10px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Link2Icon className="size-3" />
                    {fk.table}
                  </button>
                ))}
              </span>
            </td>
            <td className="px-2 py-1 font-mono">{column.typeName}</td>
            <td className="px-2 py-1">{column.nullable ? "yes" : "NO"}</td>
            <td className="px-2 py-1 font-mono break-all">
              {column.generated ? "" : (column.defaultValue ?? "")}
              {column.generated && (
                <span className="text-muted-foreground">= {column.defaultValue}</span>
              )}
            </td>
            <td className="px-2 py-1">
              <Extras column={column} />
            </td>
            <td className="px-2 py-1 text-muted-foreground">{column.comment ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
