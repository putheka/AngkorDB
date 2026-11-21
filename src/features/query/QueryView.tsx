import { useQuery } from "@tanstack/react-query";
import { PanelBottomIcon, PanelRightIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWriteApproval } from "@/features/safety/approval";
import { buildIndex } from "@/features/query/completion/suggest";
import {
  nextRunId,
  useQueryView,
  useQueryViews,
  type PinnedResult,
} from "@/features/query/queryViews";
import { pickTab } from "@/features/query/resultTabs";
import { ResultsPane } from "@/features/query/ResultsPane";
import { SqlEditor, type RunMode, type SqlEditorHandle } from "@/features/query/SqlEditor";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { commands } from "@/lib/ipc";
import { useStatusStore } from "@/stores/status";
import type { QueryTab } from "@/stores/tabs";

const MIN_EDITOR = 96;
const MIN_RESULTS = 120;
const MIN_RESULTS_WIDTH = 240;

/** A SQL editor over its results, on a connection of its own. */
export function QueryView({ connectionId, tab }: { connectionId: string; tab: QueryTab }) {
  const { view, update } = useQueryView(tab.id);
  const editor = useRef<SqlEditorHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; size: number } | null>(null);

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
          lastRun: { id: nextRunId(), result, base, sql },
          resultTab: pickTab(result.statements),
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

  const stop = useCallback(
    () => void commands.cancelQuery(connectionId, tab.id).catch(() => undefined),
    [connectionId, tab.id],
  );

  // ⌘. stops what is running, wherever the focus is (the editor included).
  useEffect(() => {
    if (!view.running) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.code === "Period") {
        e.preventDefault();
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view.running, stop]);

  // Elapsed time while a statement runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!view.running) return;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [view.running]);
  const elapsed = view.running && view.startedAt ? (now - view.startedAt) / 1000 : 0;

  // The status bar shows the size and time of the result in front.
  const front = view.resultTab;
  const shown =
    front.kind === "result"
      ? view.lastRun?.result.statements[front.index]
      : front.kind === "pinned"
        ? view.pinned.find((p) => p.id === front.id)
        : undefined;
  const shownMs = shown?.durationMs ?? null;
  const shownRows =
    shown && "outcome" in shown && shown.outcome.kind === "rows" ? shown.outcome.rows.length : null;
  useEffect(() => {
    useStatusStore.getState().set({
      rowCount: shownRows === null ? null : { count: shownRows, exact: true },
      queryMs: shownMs,
    });
  }, [shownRows, shownMs]);
  useEffect(() => () => useStatusStore.getState().clear(), []);

  // Drag the bar between the editor and the results: up and down, or left and right.
  const horizontal = view.layout === "right";
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = horizontal
      ? { start: e.clientX, size: view.editorWidth }
      : { start: e.clientY, size: view.editorHeight };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const delta = (horizontal ? e.clientX : e.clientY) - drag.current.start;
    const total = horizontal ? (body.current?.clientWidth ?? 0) : (body.current?.clientHeight ?? 0);
    const room = total - (horizontal ? MIN_RESULTS_WIDTH : MIN_RESULTS);
    const next = Math.round(
      Math.min(Math.max(drag.current.size + delta, MIN_EDITOR), Math.max(room, MIN_EDITOR)),
    );
    update(horizontal ? { editorWidth: next } : { editorHeight: next });
  };
  const endDrag = () => {
    drag.current = null;
  };

  const pin = (index: number) => {
    const run = view.lastRun;
    const statement = run?.result.statements[index];
    if (!run || statement?.outcome.kind !== "rows") return;
    const number =
      Math.max(0, ...view.pinned.map((p) => Number(p.title.replace(/\D/g, "")) || 0)) + 1;
    const kept: PinnedResult = {
      id: nextRunId(),
      title: `Pinned ${number}`,
      outcome: statement.outcome,
      durationMs: statement.durationMs,
      sql: run.sql.slice(statement.range.start, statement.range.end),
    };
    update({ pinned: [...view.pinned, kept], resultTab: { kind: "pinned", id: kept.id } });
  };
  const unpin = (id: number) => {
    const pinned = view.pinned.filter((p) => p.id !== id);
    const gone = view.resultTab.kind === "pinned" && view.resultTab.id === id;
    update({
      pinned,
      ...(gone ? { resultTab: pickTab(view.lastRun?.result.statements ?? []) } : {}),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
        {view.running ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="xs" variant="destructive" onClick={stop}>
                <SquareIcon /> Stop
              </Button>
            </TooltipTrigger>
            <TooltipContent>Stop the running statement (⌘.)</TooltipContent>
          </Tooltip>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto"
              aria-label={horizontal ? "Show results below" : "Show results on the right"}
              onClick={() => update({ layout: horizontal ? "below" : "right" })}
            >
              {horizontal ? <PanelBottomIcon /> : <PanelRightIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {horizontal ? "Results below the editor" : "Results to the right of the editor"}
          </TooltipContent>
        </Tooltip>
      </div>

      <div ref={body} className={cn("flex min-h-0 flex-1", horizontal ? "flex-row" : "flex-col")}>
        <div
          style={horizontal ? { width: view.editorWidth } : { height: view.editorHeight }}
          className="shrink-0 overflow-hidden"
        >
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
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-label="Resize editor"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => update(horizontal ? { editorWidth: 560 } : { editorHeight: 240 })}
          className={cn(
            "group relative shrink-0 touch-none bg-muted/40 hover:bg-ring/30",
            horizontal ? "w-1.5 cursor-col-resize border-x" : "h-1.5 cursor-row-resize border-y",
          )}
        />

        <div className="min-h-0 min-w-0 flex-1">
          <ResultsPane
            run={view.lastRun}
            pinned={view.pinned}
            tab={view.resultTab}
            running={view.running}
            runError={view.runError}
            onTab={(resultTab) => update({ resultTab })}
            onPin={pin}
            onUnpin={unpin}
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
    </div>
  );
}
