import { useMemo, useState } from "react";

import type { QueryRun, SortSpec, StatementOutcome, StatementResult } from "@/bindings";
import { Button } from "@/components/ui/button";
import { EMPTY_LAYOUT } from "@/features/grid/columns";
import { DataGrid } from "@/features/grid/DataGrid";
import { sortRows } from "@/features/query/sortRows";
import { summarize } from "@/features/query/summarize";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const number = new Intl.NumberFormat("en-US");

interface ResultsPaneProps {
  run: { id: number; result: QueryRun; selected: number } | null;
  running: boolean;
  /** The run couldn't take place at all. */
  runError: string | null;
  onSelect: (index: number) => void;
  /** Put the editor cursor on the error of statement `index`. */
  onGoToError: (index: number) => void;
}

/** What the last run returned: a chip per statement when there are several, then its result. */
export function ResultsPane({ run, running, runError, onSelect, onGoToError }: ResultsPaneProps) {
  if (runError) {
    return (
      <div role="alert" className="p-4 text-sm select-text">
        <p className="font-medium text-destructive">{runError}</p>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
        <p>{running ? "Running…" : "Results appear here."}</p>
        {!running && (
          <p className="text-xs">
            <kbd className="font-sans">⌘↵</kbd> runs the selection or the statement at the cursor,{" "}
            <kbd className="font-sans">⌘⇧↵</kbd> runs everything.
          </p>
        )}
      </div>
    );
  }

  const { statements } = run.result;
  if (statements.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        There was no SQL to run: the text is empty or only comments.
      </p>
    );
  }
  const shown = statements[run.selected] ?? statements[statements.length - 1];

  return (
    <div className={cn("flex h-full min-h-0 flex-col", running && "opacity-60")}>
      {statements.length > 1 && (
        <div
          role="tablist"
          aria-label="Statements"
          className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1"
        >
          {statements.map((statement, index) => (
            <Chip
              key={index}
              index={index}
              statement={statement}
              selected={statement === shown}
              onClick={() => onSelect(index)}
            />
          ))}
        </div>
      )}
      {shown && (
        <Outcome
          key={`${run.id}:${statements.indexOf(shown)}`}
          statement={shown}
          onGoToError={() => onGoToError(statements.indexOf(shown))}
        />
      )}
    </div>
  );
}

function Chip({
  index,
  statement,
  selected,
  onClick,
}: {
  index: number;
  statement: StatementResult;
  selected: boolean;
  onClick: () => void;
}) {
  const failed = statement.outcome.kind === "error";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        "shrink-0 rounded-md border px-2 py-0.5 text-xs whitespace-nowrap",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
        failed && "border-destructive/50 text-destructive",
      )}
    >
      {index + 1} · {summarize(statement.outcome)} · {formatDuration(statement.durationMs)}
    </button>
  );
}

function Outcome({
  statement,
  onGoToError,
}: {
  statement: StatementResult;
  onGoToError: () => void;
}) {
  const { outcome } = statement;
  const time = formatDuration(statement.durationMs);

  if (outcome.kind === "error") {
    const { error } = outcome;
    return (
      <div role="alert" className="min-h-0 flex-1 overflow-auto p-4 text-sm select-text">
        <p className="font-medium text-destructive">{error.message}</p>
        {error.pgCode && (
          <p className="mt-1 text-xs text-muted-foreground">
            SQLSTATE <span className="font-mono">{error.pgCode}</span>
          </p>
        )}
        {error.detail && <p className="mt-2 text-xs text-muted-foreground">{error.detail}</p>}
        {error.hint && <p className="mt-1 text-xs text-muted-foreground">Hint: {error.hint}</p>}
        {outcome.offset !== null && (
          <Button variant="outline" size="xs" className="mt-3" onClick={onGoToError}>
            Go to error
          </Button>
        )}
      </div>
    );
  }

  if (outcome.kind === "command") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 text-sm">
        <p className="font-medium">{summarize(outcome)}</p>
        <p className="text-xs text-muted-foreground">Completed in {time}.</p>
      </div>
    );
  }

  return <RowsResult outcome={outcome} time={time} />;
}

function RowsResult({
  outcome,
  time,
}: {
  outcome: Extract<StatementOutcome, { kind: "rows" }>;
  time: string;
}) {
  // Sorting, column widths and hidden columns belong to this result only (the parent keys it).
  const [layout, setLayout] = useState(EMPTY_LAYOUT);
  const [sort, setSort] = useState<SortSpec[]>([]);
  const rows = useMemo(
    () => sortRows(outcome.columns, outcome.rows, sort),
    [outcome.columns, outcome.rows, sort],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        <DataGrid
          columns={outcome.columns}
          rows={rows}
          firstRowNumber={1}
          layout={layout}
          onLayoutChange={setLayout}
          sort={sort}
          onSortChange={setSort}
        />
        {outcome.rows.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-24 text-center text-sm text-muted-foreground">
            The query returned no rows.
          </p>
        )}
      </div>
      <footer className="flex h-7 shrink-0 items-center gap-3 border-t px-3 text-xs text-muted-foreground tabular-nums">
        <span>
          {number.format(outcome.rows.length)} {outcome.rows.length === 1 ? "row" : "rows"} · {time}
        </span>
        {outcome.truncated && (
          <span className="text-amber-600 dark:text-amber-400">
            Results cut at {number.format(outcome.rows.length)} rows. Add a LIMIT or a WHERE to see
            the rest.
          </span>
        )}
      </footer>
    </div>
  );
}
