/**
 * Keeping the workspace across launches (ANG-50): the open connection's tabs, query text and
 * table views are written to disk (by the backend) shortly after they change, and put back when
 * the connection is opened again. Which connection to reopen at launch is kept the same way.
 */
import type { ConnectionConfig } from "@/bindings";
import { useTableViews, DEFAULT_VIEW } from "@/features/grid/tableViews";
import { DEFAULT_QUERY_VIEW, useQueryViews } from "@/features/query/queryViews";
import {
  captureWorkspace,
  parseWorkspace,
  serializeWorkspace,
} from "@/features/workspace/snapshot";
import { commands } from "@/lib/ipc";
import { useBrowserStore } from "@/stores/browser";
import { useTabsStore } from "@/stores/tabs";

/** How long after a change the workspace is written: a query is never more than this far from disk. */
export const SAVE_DELAY_MS = 2000;

/** What was last written per connection, so an unchanged workspace is not written again. */
const lastSaved = new Map<string, string>();
let restoring = false;

function currentText(): string {
  const tabs = useTabsStore.getState();
  return serializeWorkspace(
    captureWorkspace({
      tabs: tabs.tabs,
      activeId: tabs.activeId,
      nextQueryNumber: tabs.nextQueryNumber,
      schema: useBrowserStore.getState().schema,
      queryViews: useQueryViews.getState().views,
      tableViews: useTableViews.getState().views,
    }),
  );
}

/** Write the workspace of `connectionId` now, if it changed since the last write. */
export async function saveWorkspaceNow(connectionId: string): Promise<void> {
  const text = currentText();
  if (lastSaved.get(connectionId) === text) return;
  try {
    await commands.saveWorkspace(connectionId, text);
    lastSaved.set(connectionId, text);
  } catch {
    // Not being able to keep the workspace must never get in the way of working.
  }
}

/**
 * Write the workspace of the open connection a moment after anything in it changes, and at once
 * when the window is hidden or closed. Returns a function that stops it.
 */
export function startAutosave(openConnectionId: () => string | null): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const id = openConnectionId();
    if (id && !restoring) void saveWorkspaceNow(id);
  };
  const schedule = () => {
    if (timer !== null || restoring || !openConnectionId()) return;
    timer = setTimeout(flush, SAVE_DELAY_MS);
  };
  const onHidden = () => {
    if (document.visibilityState === "hidden") flush();
  };

  const stops = [
    useTabsStore.subscribe(schedule),
    useQueryViews.subscribe(schedule),
    useTableViews.subscribe(schedule),
    useBrowserStore.subscribe(schedule),
  ];
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", flush);
  return () => {
    for (const stop of stops) stop();
    document.removeEventListener("visibilitychange", onHidden);
    window.removeEventListener("pagehide", flush);
    if (timer !== null) clearTimeout(timer);
  };
}

/**
 * Put the workspace last kept for a connection back: its tabs, the text of its queries, how
 * its tables were sorted and filtered. Does nothing when tabs are already open or nothing is
 * kept. Returns whether anything came back.
 */
export async function restoreWorkspace(connectionId: string): Promise<boolean> {
  if (useTabsStore.getState().tabs.length > 0) return false;
  restoring = true;
  try {
    const text = await commands.loadWorkspace(connectionId);
    const workspace = text ? parseWorkspace(text) : null;
    if (!workspace) return false;
    // Tabs first: a view whose tab is not open is cleaned away as soon as it is set.
    useTabsStore.setState({
      tabs: workspace.tabs,
      activeId: workspace.activeId,
      nextQueryNumber: workspace.nextQueryNumber,
    });
    useQueryViews.setState((state) => ({
      views: {
        ...state.views,
        ...Object.fromEntries(
          Object.entries(workspace.queries).map(([id, view]) => [
            id,
            { ...DEFAULT_QUERY_VIEW, ...view },
          ]),
        ),
      },
    }));
    useTableViews.setState((state) => ({
      views: {
        ...state.views,
        ...Object.fromEntries(
          Object.entries(workspace.tables).map(([id, view]) => [id, { ...DEFAULT_VIEW, ...view }]),
        ),
      },
    }));
    useBrowserStore.getState().setSchema(workspace.schema);
    return workspace.tabs.length > 0;
  } catch {
    return false;
  } finally {
    restoring = false;
  }
}

/** The connection to reopen at launch, if the person wants that and it still exists. */
export async function connectionToReopen(): Promise<ConnectionConfig | null> {
  try {
    const startup = await commands.startupState();
    if (!startup.restoreOnLaunch || !startup.lastConnectionId) return null;
    const connections = await commands.listConnections();
    return connections.find((c) => c.id === startup.lastConnectionId) ?? null;
  } catch {
    return null;
  }
}
