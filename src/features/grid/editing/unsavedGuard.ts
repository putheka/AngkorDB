import { create } from "zustand";

import type { ConnectionConfig } from "@/bindings";
import { connectionsKey } from "@/features/connections/useConnections";
import { describePending } from "@/features/grid/editing/changes";
import { saveStructureStaged } from "@/features/structure/edit/saveStructure";
import { useStructureEditStore } from "@/features/structure/edit/structureEditStore";
import { useChangesStore } from "@/features/grid/editing/changeStore";
import { saveStaged } from "@/features/grid/editing/saveStaged";
import { describeDirty, dirtyTabs, type DirtyTab } from "@/features/grid/editing/unsaved";
import { approveWrite } from "@/features/safety/approval";
import { queryClient } from "@/lib/queryClient";

/** What is about to happen that would throw the edits away: "close this tab", "quit". */
export interface UnsavedRequest {
  connectionId: string;
  tabs: DirtyTab[];
  verb: string;
}

interface GuardState {
  request: UnsavedRequest | null;
  ask: (request: UnsavedRequest) => Promise<boolean>;
  answer: (go: boolean) => void;
}

let waiting: ((go: boolean) => void) | null = null;

export const useUnsavedGuard = create<GuardState>()((set) => ({
  request: null,
  ask: (request) =>
    new Promise((resolve) => {
      waiting?.(false);
      waiting = resolve;
      set({ request });
    }),
  answer: (go) => {
    const done = waiting;
    waiting = null;
    set({ request: null });
    done?.(go);
  },
}));

/**
 * Before something that would lose staged edits (closing tabs, disconnecting, switching
 * database, quitting): with none staged it is `true` at once; otherwise a dialog offers to save
 * them, throw them away or stop. `true` means go ahead (saved or discarded), `false` means don't.
 */
export async function guardUnsaved(
  connectionId: string | null,
  verb: string,
  only?: readonly string[],
): Promise<boolean> {
  const tabs = dirtyTabs(only);
  if (tabs.length === 0) return true;
  // Staged edits belong to an open connection; with none there is nothing to save to.
  if (!connectionId) {
    for (const { tab } of tabs) {
      useChangesStore.getState().discard(tab.id);
      useStructureEditStore.getState().discard(tab.id);
    }
    return true;
  }
  return useUnsavedGuard.getState().ask({ connectionId, tabs, verb });
}

/** Save every tab of the request, asking first if the connection's safe mode says so. */
export async function saveAll({ connectionId, tabs }: UnsavedRequest): Promise<boolean> {
  const connections = queryClient.getQueryData<ConnectionConfig[]>(connectionsKey) ?? [];
  const connection = connections.find((c) => c.id === connectionId);
  const approved = await approveWrite(connection?.safeMode ?? "off", {
    title: `Save changes to ${connection?.name ?? "this database"}?`,
    lines: tabs.map(
      (dirty) => `${dirty.tab.schema}.${dirty.tab.name}: ${describeDirty(dirty, describePending)}`,
    ),
    reason: `save changes to ${connection?.name ?? "the database"}`,
  });
  if (!approved) return false;
  // One table after the other; the first failure stops, and what was saved stays saved. The rows
  // go first: their edits name columns, which the structure changes could rename or drop.
  const notices: string[] = [];
  for (const { tab, summary, structure } of tabs) {
    if (summary.total > 0) await saveStaged(connectionId, tab);
    if (structure) {
      const notice = await saveStructureStaged(connectionId, tab);
      if (notice) notices.push(`${tab.schema}.${tab.name}: ${notice}`);
    }
  }
  // Part of a save that could not run: it is said, and the dialog stays so it can be read.
  if (notices.length > 0) throw new Error(notices.join("\n"));
  return true;
}

/** Throw the staged edits of these tabs away. */
export function discardAll({ tabs }: UnsavedRequest) {
  for (const { tab } of tabs) {
    useChangesStore.getState().discard(tab.id);
    useStructureEditStore.getState().discard(tab.id);
  }
}
