import { DownloadIcon, PinIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { Notice, SortSpec, StatementOutcome, StatementResult } from "@/bindings";
import { Button } from "@/components/ui/button";
import { EMPTY_LAYOUT } from "@/features/grid/columns";
import { DataGrid } from "@/features/grid/DataGrid";
import { PlanView } from "@/features/query/plan/PlanView";
import type { LastRun, PinnedResult, PlanRun } from "@/features/query/queryViews";
import { messageCount, resultsOf, sameTab, type ResultTab } from "@/features/query/resultTabs";
import { sortRows } from "@/features/query/sortRows";
import { summarize } from "@/features/query/summarize";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const number = new Intl.NumberFormat("en-US");

type RowsOutcome = Extract<StatementOutcome, { kind: "rows" }>;

interface ResultsPaneProps {
  run: LastRun | null;
  pinned: PinnedResult[];
  /** The plan of the last Explain / Analyze. */
  plan: PlanRun | null;
  tab: ResultTab;
  running: boolean;
  /** The run couldn't take place at all. */
  runError: string | null;
  onTab: (tab: ResultTab) => void;
  /** Keep the rows of statement `index` of the last run. */
  onPin: (index: number) => void;
  onUnpin: (id: number) => void;
  /** Export what a statement returned: the text of that statement. */
  onExport?: (sql: string) => void;
  onClosePlan: () => void;
  /** Put the editor cursor on the error of statement `index`. */
  onGoToError: (index: number) => void;
  /** Put the editor cursor on the error of the plan. */
  onGoToPlanError: () => void;
}

/**
 * What the last run returned. One tab per statement that returned rows (`Result 1`, `Result 2`),
 * a `Messages` tab with every statement's outcome, timing and notices, and the results that were
 * pinned from earlier runs.
 */
export function ResultsPane(props: ResultsPaneProps) {
  const {
    run,
    pinned,
    plan,
    tab,
    running,
    runError,
    onTab,
    onPin,
    onUnpin,
    onExport,
    onClosePlan,
    onGoToError,
    onGoToPlanError,
  } = props;

  if (runError) {
    return (
      <div role="alert" className="p-4 text-sm select-text">
        <p className="font-medium text-destructive">{runError}</p>
      </div>
    );
  }
  if (!run && pinned.length === 0 && !plan) {
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

  const statements = run?.result.statements ?? [];
  const results = resultsOf(statements);
  const messages = messageCount(statements);

  let body;
  if (tab.kind === "plan") {
    body = plan ? <PlanView key={plan.id} run={plan.run} onGoToError={onGoToPlanError} /> : null;
  } else if (tab.kind === "pinned") {
    const kept = pinned.find((p) => p.id === tab.id);
    body = kept ? (
      <RowsResult
        key={`pinned:${kept.id}`}
        outcome={kept.outcome}
        time={formatDuration(kept.durationMs)}
      />
    ) : null;
  } else if (tab.kind === "result") {
    const statement = statements[tab.index];
    body =
      statement?.outcome.kind === "rows" ? (
        <RowsResult
          key={`${run?.id}:${tab.index}`}
          outcome={statement.outcome}
          time={formatDuration(statement.durationMs)}
          onPin={() => onPin(tab.index)}
          {...(onExport && run
            ? {
                onExport: () => onExport(run.sql.slice(statement.range.start, statement.range.end)),
              }
            : {})}
        />
      ) : null;
  } else {
    body = run ? <Messages run={run} onGoToError={onGoToError} /> : null;
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", running && "opacity-60")}>
      <div
        role="tablist"
        aria-label="Results"
        className="flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1"
      >
        {results.map((result) => (
          <TabButton
            key={`result:${result.index}`}
            selected={sameTab(tab, { kind: "result", index: result.index })}
            onClick={() => onTab({ kind: "result", index: result.index })}
          >
            Result {result.number} · {number.format(result.rows)}{" "}
            {result.rows === 1 ? "row" : "rows"}
          </TabButton>
        ))}
        {run && (
          <TabButton
            selected={tab.kind === "messages"}
            failed={statements[statements.length - 1]?.outcome.kind === "error"}
            onClick={() => onTab({ kind: "messages" })}
          >
            Messages
            {messages > 0 && (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10px] tabular-nums">
                {messages}
              </span>
            )}
          </TabButton>
        )}
        {plan && (
          <TabButton
            selected={tab.kind === "plan"}
            failed={plan.run.outcome.kind === "error"}
            onClick={() => onTab({ kind: "plan" })}
            onClose={onClosePlan}
            closeLabel="Close plan"
          >
            {plan.analyze ? "Analyze" : "Explain"}
          </TabButton>
        )}
        {pinned.map((kept) => (
          <TabButton
            key={`pinned:${kept.id}`}
            selected={sameTab(tab, { kind: "pinned", id: kept.id })}
            onClick={() => onTab({ kind: "pinned", id: kept.id })}
            onClose={() => onUnpin(kept.id)}
            title={kept.sql}
          >
            <PinIcon className="mr-1 size-3 shrink-0" />
            {kept.title}
          </TabButton>
        ))}
      </div>
      {body}
    </div>
  );
}

function TabButton({
  selected,
  failed,
  onClick,
  onClose,
  closeLabel = "Unpin result",
  title,
  children,
}: {
  selected: boolean;
  failed?: boolean;
  onClick: () => void;
  onClose?: () => void;
  closeLabel?: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center rounded-md border text-xs whitespace-nowrap",
        selected
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:text-foreground",
        failed && "border-destructive/50 text-destructive",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        title={title}
        onClick={onClick}
        className="flex items-center px-2 py-0.5"
      >
        {children}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="rounded-r-md px-1 py-0.5 opacity-60 hover:opacity-100"
        >
          <XIcon className="size-3" />
        </button>
      )}
    </span>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  WARNING: "text-amber-600 dark:text-amber-400",
  ERROR: "text-destructive",
};

function Messages({ run, onGoToError }: { run: LastRun; onGoToError: (index: number) => void }) {
  const { statements, durationMs } = run.result;
  if (statements.length === 0) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        There was no SQL to run: the text is empty or only comments.
      </p>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-xs select-text">
      <p className="mb-2 text-muted-foreground">
        {statements.length} {statements.length === 1 ? "statement" : "statements"} in{" "}
        {formatDuration(durationMs)}
      </p>
      <ol className="flex flex-col gap-2">
        {statements.map((statement, index) => (
          <Message
            key={index}
            index={index}
            statement={statement}
            sql={run.sql.slice(statement.range.start, statement.range.end)}
            onGoToError={() => onGoToError(index)}
          />
        ))}
      </ol>
    </div>
  );
}

function Message({
  index,
  statement,
  sql,
  onGoToError,
}: {
  index: number;
  statement: StatementResult;
  sql: string;
  onGoToError: () => void;
}) {
  const { outcome } = statement;
  const failed = outcome.kind === "error";
  const oneLine = sql.replace(/\s+/g, " ").trim();
  return (
    <li className={cn("rounded-md border p-2", failed && "border-destructive/40")}>
      <div className="flex items-baseline gap-2">
        <span className="text-muted-foreground tabular-nums">{index + 1}</span>
        <span className={cn("font-medium", failed && "text-destructive")}>
          {failed ? outcome.error.message : summarize(outcome)}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {formatDuration(statement.durationMs)}
        </span>
      </div>
      <p className="mt-1 truncate font-mono text-muted-foreground" title={oneLine}>
        {oneLine.length > 160 ? `${oneLine.slice(0, 160)}…` : oneLine}
      </p>
      {statement.notices.map((notice, i) => (
        <NoticeLine key={i} notice={notice} />
      ))}
      {outcome.kind === "error" && (
        <div className="mt-1 text-muted-foreground">
          {outcome.error.pgCode && (
            <p>
              SQLSTATE <span className="font-mono">{outcome.error.pgCode}</span>
            </p>
          )}
          {outcome.error.detail && <p>{outcome.error.detail}</p>}
          {outcome.error.hint && <p>Hint: {outcome.error.hint}</p>}
          {outcome.offset !== null && (
            <Button variant="outline" size="xs" className="mt-1.5" onClick={onGoToError}>
              Go to error
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <div className="mt-1">
      <p>
        <span className={cn("font-medium", SEVERITY_STYLE[notice.severity])}>
          {notice.severity}
        </span>
        <span className="text-muted-foreground">: </span>
        {notice.message}
      </p>
      {notice.detail && <p className="text-muted-foreground">DETAIL: {notice.detail}</p>}
      {notice.hint && <p className="text-muted-foreground">HINT: {notice.hint}</p>}
    </div>
  );
}

function RowsResult({
  outcome,
  time,
  onPin,
  onExport,
}: {
  outcome: RowsOutcome;
  time: string;
  onPin?: () => void;
  onExport?: () => void;
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
        <span className="ml-auto flex items-center gap-1">
          {onExport && (
            <Button variant="ghost" size="xs" aria-label="Export the result" onClick={onExport}>
              <DownloadIcon /> Export
            </Button>
          )}
          {onPin && (
            <Button variant="ghost" size="xs" onClick={onPin}>
              <PinIcon /> Pin
            </Button>
          )}
        </span>
      </footer>
    </div>
  );
}
