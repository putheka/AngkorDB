import { useCallback } from "react";
import { create } from "zustand";

import type { ExplainRun, QueryRun, StatementOutcome } from "@/bindings";
import { pickTab, type ResultTab } from "@/features/query/resultTabs";
import { commands } from "@/lib/ipc";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";

/** What the last run of a query tab produced, and where its text sat in the editor. */
export interface LastRun {
  /** Changes with every run; keys the result grid so its sort and widths start over. */
  id: number;
  result: QueryRun;
  /** Offset in the editor of the text that was run: 0 for everything, the selection's start, ... */
  base: number;
  /** The text that was run (the statements' ranges are into it). */
  sql: string;
}

/** The rows of a result that were kept from an earlier run. */
export interface PinnedResult {
  id: number;
  /** "Pinned 1": the tab's name. */
  title: string;
  outcome: Extract<StatementOutcome, { kind: "rows" }>;
  durationMs: number;
  /** The statement that produced it, for the tab's tooltip. */
  sql: string;
}

/** The last Explain / Analyze of a query tab. */
export interface PlanRun {
  /** Changes with every run. */
  id: number;
  analyze: boolean;
  /** Offset in the editor of the statement that was explained (for pointing at an error). */
  base: number;
  run: ExplainRun;
}

/** Everything about one query tab that must survive switching to another tab and back. */
export interface QueryView {
  text: string;
  selection: { anchor: number; head: number };
  /** Height of the editor in pixels; the results take the rest. */
  editorHeight: number;
  running: boolean;
  /** When the current run started (`Date.now()`), for the timer. */
  startedAt: number | null;
  lastRun: LastRun | null;
  /** Which result is in front. */
  resultTab: ResultTab;
  /** The plan of the last Explain / Analyze. */
  plan: PlanRun | null;
  /** Results kept across runs. */
  pinned: PinnedResult[];
  /** Results below the editor, or to its right. */
  layout: "below" | "right";
  /** Width of the editor in pixels when the results are to its right. */
  editorWidth: number;
  /** The history list beside the editor is showing. */
  historyOpen: boolean;
  /** The run itself could not happen (lost connection, ...), as opposed to a statement failing. */
  runError: string | null;
}

export const DEFAULT_QUERY_VIEW: QueryView = {
  text: "",
  selection: { anchor: 0, head: 0 },
  editorHeight: 240,
  running: false,
  startedAt: null,
  lastRun: null,
  resultTab: pickTab([]),
  plan: null,
  pinned: [],
  layout: "below",
  editorWidth: 560,
  historyOpen: false,
  runError: null,
};

interface QueryViewsState {
  views: Record<string, QueryView>;
  update: (tabId: string, patch: Partial<QueryView>) => void;
}

export const useQueryViews = create<QueryViewsState>()((set) => ({
  views: {},
  update: (tabId, patch) =>
    set((state) => ({
      views: {
        ...state.views,
        [tabId]: { ...(state.views[tabId] ?? DEFAULT_QUERY_VIEW), ...patch },
      },
    })),
}));

/** The state of a query tab, and a function to change it. */
export function useQueryView(tabId: string) {
  const view = useQueryViews((s) => s.views[tabId] ?? DEFAULT_QUERY_VIEW);
  const updateView = useQueryViews((s) => s.update);
  const update = useCallback(
    (patch: Partial<QueryView>) => updateView(tabId, patch),
    [updateView, tabId],
  );
  return { view, update };
}

let runCounter = 0;
export const nextRunId = () => ++runCounter;

// A closed tab takes its text and results with it, and its database connection is closed.
useTabsStore.subscribe((state) => {
  const open = new Set(state.tabs.map((t) => t.id));
  const { views } = useQueryViews.getState();
  const gone = Object.keys(views).filter((id) => !open.has(id));
  if (gone.length === 0) return;

  useQueryViews.setState({
    views: Object.fromEntries(Object.entries(views).filter(([id]) => open.has(id))),
  });
  // After a disconnect there is no connection id, and the server side is closed with it.
  const connectionId = useSessionStore.getState().activeConnectionId;
  if (connectionId) {
    for (const tabId of gone) {
      void commands.closeQueryTab(connectionId, tabId).catch(() => undefined);
    }
  }
});
