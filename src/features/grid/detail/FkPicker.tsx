import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";

import { Input } from "@/components/ui/input";
import type { ForeignKeyGroup } from "@/features/grid/foreignKeys";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";

/** Rows offered at most. */
const LIMIT = 100;

interface FkPickerProps {
  connectionId: string;
  group: ForeignKeyGroup;
  /** The values to write, by column of this table, for the row that was picked. */
  onPick: (values: Record<string, string | null>) => void;
  onClose: () => void;
}

const short = (text: string, max = 28) => (text.length > max ? `${text.slice(0, max)}…` : text);

/**
 * Choose the row a foreign key should point at: search the referenced column of the target table
 * and pick one of the first 100 matches. For a composite key every column of it is set at once.
 */
export function FkPicker({ connectionId, group, onPick, onClose }: FkPickerProps) {
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());
  const first = group.pairs[0];

  const rows = useQuery({
    queryKey: ["data", connectionId, "fk-pick", group.schema, group.table, first?.target, query],
    queryFn: () =>
      commands.fetchRows(connectionId, {
        schema: group.schema,
        table: group.table,
        limit: LIMIT,
        offset: 0,
        sort: first ? [{ column: first.target, dir: "asc" }] : [],
        filters:
          first && query !== ""
            ? [{ column: first.target, op: "iLike", values: [`%${query}%`] }]
            : [],
        rawWhere: null,
      }),
    placeholderData: keepPreviousData,
    enabled: first !== undefined,
  });
  const page = rows.data;

  const pick = (row: (string | null)[]) => {
    if (!page) return;
    const values: Record<string, string | null> = {};
    for (const pair of group.pairs) {
      const at = page.columns.findIndex((c) => c.name === pair.target);
      values[pair.column] = row[at] ?? null;
    }
    onPick(values);
  };

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-2"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Input
        autoFocus
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${first?.target ?? "value"} in ${group.table}`}
        aria-label={`Search ${group.table}`}
        spellCheck={false}
        className="h-7 text-xs"
      />
      {rows.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(rows.error)}
        </p>
      ) : (
        <ul
          role="listbox"
          aria-label={`Rows of ${group.table}`}
          className="max-h-48 overflow-y-auto text-xs"
        >
          {page?.rows.map((row, i) => {
            const key = group.pairs.map((p) => {
              const at = page.columns.findIndex((c) => c.name === p.target);
              return row[at] ?? "NULL";
            });
            // A little context so the right row is recognisable: the next columns with something in them.
            const hint = page.columns
              .map((c, at) => ({ name: c.name, value: row[at] }))
              .filter((c) => !group.pairs.some((p) => p.target === c.name) && c.value)
              .slice(0, 2)
              .map((c) => short(c.value ?? ""))
              .join(" · ");
            return (
              <li key={i} role="option" aria-selected={false}>
                <button
                  type="button"
                  onClick={() => pick(row)}
                  className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
                >
                  <span className="shrink-0 font-mono font-medium">{key.join(", ")}</span>
                  <span className="truncate text-muted-foreground">{hint}</span>
                </button>
              </li>
            );
          })}
          {page && page.rows.length === 0 && (
            <li className="px-1.5 py-1 text-muted-foreground">Nothing matches.</li>
          )}
          {!page && <li className="px-1.5 py-1 text-muted-foreground">Loading…</li>}
        </ul>
      )}
      {page?.hasMore && (
        <p className="text-[11px] text-muted-foreground">
          Showing the first {LIMIT}; type to narrow it down.
        </p>
      )}
    </div>
  );
}
