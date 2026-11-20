import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon } from "lucide-react";

import type { IncomingForeignKey } from "@/bindings";
import { referencedValues, tableLabel } from "@/features/grid/foreignKeys";
import { commands } from "@/lib/ipc";

/** Counted up to this many; more shows as `1000+`. */
const CAP = 1000;

interface ReferencedByProps {
  connectionId: string;
  /** The schema of the table being looked at, to shorten names in it. */
  schema: string;
  incoming: IncomingForeignKey[];
  /** What the row holds in a column, `null` for NULL. */
  valueOf: (column: string) => string | null;
  onOpen: (fk: IncomingForeignKey, values: string[]) => void;
}

/** Other tables that point at this row, how many rows each has, and a link to see them. */
export function ReferencedBy({
  connectionId,
  schema,
  incoming,
  valueOf,
  onOpen,
}: ReferencedByProps) {
  if (incoming.length === 0) return null;
  return (
    <section aria-label="Referenced by" className="flex flex-col gap-1 border-t pt-3">
      <h3 className="text-xs font-medium">Referenced by</h3>
      <ul className="flex flex-col">
        {incoming.map((fk) => (
          <ReferencingRow
            key={`${fk.schema}.${fk.table}/${fk.constraint}`}
            connectionId={connectionId}
            schema={schema}
            fk={fk}
            values={referencedValues(fk, valueOf)}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </section>
  );
}

function ReferencingRow({
  connectionId,
  schema,
  fk,
  values,
  onOpen,
}: {
  connectionId: string;
  schema: string;
  fk: IncomingForeignKey;
  values: string[] | null;
  onOpen: (fk: IncomingForeignKey, values: string[]) => void;
}) {
  const count = useQuery({
    // Under "data", so a reload (⌘R) or a save counts again.
    queryKey: ["data", connectionId, "referenced-by", fk.schema, fk.table, fk.constraint, values],
    queryFn: () =>
      commands.countMatching(
        connectionId,
        fk.schema,
        fk.table,
        fk.columns.map((column, i) => ({ column, op: "eq", values: [values?.[i] ?? ""] })),
        CAP,
      ),
    enabled: values !== null,
  });

  const label = tableLabel(fk.schema, fk.table, schema);
  const shown =
    values === null
      ? "–"
      : count.isError
        ? "?"
        : count.data
          ? `${count.data.count.toLocaleString("en-US")}${count.data.capped ? "+" : ""}`
          : "…";

  return (
    <li>
      <button
        type="button"
        disabled={values === null}
        onClick={() => values && onOpen(fk, values)}
        title={`${fk.columns.join(", ")} → ${fk.referencedColumns.join(", ")}`}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent disabled:opacity-50 disabled:hover:bg-transparent"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{label}</span>
          <span className="ml-1 text-muted-foreground">{fk.columns.join(", ")}</span>
        </span>
        <span className="shrink-0 text-muted-foreground tabular-nums" aria-label="rows">
          {shown}
        </span>
        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
      </button>
    </li>
  );
}
