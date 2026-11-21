import { useQuery } from "@tanstack/react-query";
import { PlayIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWriteApproval } from "@/features/safety/approval";
import { buildIndex } from "@/features/query/completion/suggest";
import { nextRunId, useQueryView, useQueryViews } from "@/features/query/queryViews";
import { ResultsPane } from "@/features/query/ResultsPane";
import { SqlEditor, type RunMode, type SqlEditorHandle } from "@/features/query/SqlEditor";
import { errorMessage } from "@/lib/errors";
import { commands } from "@/lib/ipc";
import { useStatusStore } from "@/stores/status";
import type { QueryTab } from "@/stores/tabs";

const MIN_EDITOR = 96;
const MIN_RESULTS = 120;

/** Which result to show first: a failure if the script stopped on one, else the last one with rows. */
function pickResult(statements: { outcome: { kind: string } }[]): number {
  const last = statements.length - 1;
  if (statements[last]?.outcome.kind === "error") return last;
  const lastRows = statements.map((s) => s.outcome.kind).lastIndexOf("rows");
  return lastRows === -1 ? Math.max(last, 0) : lastRows;
}

/** A SQL editor over its results, on a connection of its own. */
export function QueryView({ connectionId, tab }: { connectionId: string; tab: QueryTab }) {
  const { view, update } = useQueryView(tab.id);
  const editor = useRef<SqlEditorHandle>(null);
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);

  const { mode: safeMode, name: connectionName, approve } = useWriteApproval(connectionId);

  // Names to complete: tables, columns and functions of the whole database, loaded once and
  // reloaded with the schema (⌘R). It is under "schema", so a reload refreshes it too.
  const schema = useQuery({
    queryKey: ["schema", connectionId, "completion"],
    queryFn: () => commands.completionSchema(connectionId),
    staleTime: 5 * 60_000,
  });
  const completion = useMemo(() => (schema.data ? buildIndex(schema.data) : null), [schema.data]);

  const run = useCallback(
    async (sql: string, base: number) => {
      if (useQueryViews.getState().views[tab.id]?.running) return;

      // Confirm and Touch ID modes ask first when something in the script changes data or schema.
      if (safeMode === "confirm" || safeMode === "touch-id") {
        try {
          const changing = (await commands.classifySql(sql)).filter((s) => s.kind !== "read");
          if (changing.length > 0) {
            const shown = changing.slice(0, 5).map((s) => {
              const text = sql.slice(s.range.start, s.range.end).replace(/\s+/g, " ");
              return `${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
            });
            const more = changing.length - shown.length;
            const ok = await approve({
              title: `Run ${changing.length === 1 ? "a statement" : `${changing.length} statements`} that change ${connectionName}?`,
              lines: more > 0 ? [...shown, `and ${more} more`] : shown,
              reason: `run SQL that changes ${connectionName}`,
            });
            if (!ok) return;
          }
        } catch (error) {
          update({ runError: errorMessage(error) });
          return;
        }
      }

      update({ running: true, startedAt: Date.now(), runError: null });
      try {
        const result = await commands.runQuery(connectionId, tab.id, sql);
        update({
          running: false,
          startedAt: null,
          lastRun: { id: nextRunId(), result, base, selected: pickResult(result.statements) },
        });
        // A failed statement: put the cursor where the server pointed (if the tab is in front).
        const failed = result.statements[result.statements.length - 1];
        if (failed?.outcome.kind === "error" && failed.outcome.offset !== null) {
          editor.current?.showError(base + failed.outcome.offset);
        }
      } catch (error) {
        update({ running: false, startedAt: null, runError: errorMessage(error) });
      }
    },
    [connectionId, tab.id, update, safeMode, connectionName, approve],
  );

  const onRun = useCallback(
    async (mode: RunMode) => {
      const { text, from, to } = editor.current?.snapshot() ?? { text: view.text, from: 0, to: 0 };
      if (mode === "all") return void run(text, 0);
      if (to > from) return void run(text.slice(from, to), from);

      const range = await commands.statementAt(text, from);
      if (range) void run(text.slice(range.start, range.end), range.start);
      else
        update({ runError: "There is no SQL to run: the editor is empty or only has comments." });
    },
    [run, update, view.text],
  );

  const stop = () => void commands.cancelQuery(connectionId, tab.id).catch(() => undefined);

  // Elapsed time while a statement runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.running) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [view.running]);
  const elapsed = view.running && view.startedAt ? (now - view.startedAt) / 1000 : 0;

  // The status bar shows the size and time of the result in front.
  const shown = view.lastRun?.result.statements[view.lastRun.selected]?.outcome;
  const shownMs = view.lastRun?.result.statements[view.lastRun.selected]?.durationMs ?? null;
  const shownRows = shown?.kind === "rows" ? shown.rows.length : null;
  useEffect(() => {
    useStatusStore.getState().set({
      rowCount: shownRows === null ? null : { count: shownRows, exact: true },
      queryMs: shownMs,
    });
  }, [shownRows, shownMs]);
  useEffect(() => () => useStatusStore.getState().clear(), []);

  // Drag the bar between the editor and the results.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: view.editorHeight };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const room = (container.current?.clientHeight ?? 0) - MIN_RESULTS - 36; // toolbar
    const next = drag.current.startHeight + e.clientY - drag.current.startY;
    update({
      editorHeight: Math.round(Math.min(Math.max(next, MIN_EDITOR), Math.max(room, MIN_EDITOR))),
    });
  };
  const endDrag = () => {
    drag.current = null;
  };

  return (
    <div ref={container} className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        {view.running ? (
          <Button size="xs" variant="destructive" onClick={stop}>
            <SquareIcon /> Stop
          </Button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="xs" onClick={() => void onRun("current")}>
                <PlayIcon /> Run
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run the selection or the statement at the cursor (⌘↵)</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="outline"
              disabled={view.running}
              onClick={() => void onRun("all")}
            >
              Run all
            </Button>
          </TooltipTrigger>
          <TooltipContent>Run every statement in the editor (⌘⇧↵)</TooltipContent>
        </Tooltip>
        {view.running && (
          <span className="text-xs text-muted-foreground tabular-nums">
            Running… {elapsed.toFixed(1)} s
          </span>
        )}
      </div>

      <div style={{ height: view.editorHeight }} className="shrink-0 overflow-hidden">
        <SqlEditor
          ref={editor}
          initialText={view.text}
          initialSelection={view.selection}
          onTextChange={(text) => update({ text })}
          onSelectionChange={(selection) => update({ selection })}
          onRun={(mode) => void onRun(mode)}
          completion={completion}
        />
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize editor"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => update({ editorHeight: 240 })}
        className="group relative h-1.5 shrink-0 cursor-row-resize touch-none border-y bg-muted/40 hover:bg-ring/30"
      />

      <div className="min-h-0 flex-1">
        <ResultsPane
          run={view.lastRun}
          running={view.running}
          runError={view.runError}
          onSelect={(selected) =>
            view.lastRun && update({ lastRun: { ...view.lastRun, selected } })
          }
          onGoToError={(index) => {
            const statement = view.lastRun?.result.statements[index];
            if (
              view.lastRun &&
              statement?.outcome.kind === "error" &&
              statement.outcome.offset !== null
            ) {
              editor.current?.showError(view.lastRun.base + statement.outcome.offset);
              editor.current?.focus();
            }
          }}
        />
      </div>
    </div>
  );
}
