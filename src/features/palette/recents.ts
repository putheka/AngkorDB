import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { pushRecent, type Recent } from "@/features/palette/items";
import { useSessionStore } from "@/stores/session";
import { useTabsStore } from "@/stores/tabs";

interface RecentsState {
  /** Per connection: the tables and views opened last, newest first. */
  byConnection: Record<string, Recent[]>;
  add: (connectionId: string, recent: Recent) => void;
}

/** Whatever is in storage, reduced to entries that are really `{ schema, name, kind }`. */
function readSaved(value: unknown): Record<string, Recent[]> {
  if (typeof value !== "object" || value === null || !("byConnection" in value)) return {};
  const saved = value.byConnection;
  if (typeof saved !== "object" || saved === null) return {};
  const result: Record<string, Recent[]> = {};
  for (const [id, list] of Object.entries(saved)) {
    if (!Array.isArray(list)) continue;
    result[id] = list.flatMap((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "schema" in entry &&
      "name" in entry &&
      "kind" in entry &&
      typeof entry.schema === "string" &&
      typeof entry.name === "string" &&
      typeof entry.kind === "string"
        ? [{ schema: entry.schema, name: entry.name, kind: entry.kind as Recent["kind"] }]
        : [],
    );
  }
  return result;
}

export const useRecents = create<RecentsState>()(
  persist(
    (set) => ({
      byConnection: {},
      add: (connectionId, recent) =>
        set((state) => ({
          byConnection: {
            ...state.byConnection,
            [connectionId]: pushRecent(state.byConnection[connectionId] ?? [], recent),
          },
        })),
    }),
    {
      name: "angkordb.recents",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ byConnection }) => ({ byConnection }),
      merge: (saved, current) => ({ ...current, byConnection: readSaved(saved) }),
    },
  ),
);

// Whatever table comes to the front, from the sidebar, the palette or a tab click, is "recent".
useTabsStore.subscribe((state, previous) => {
  if (state.activeId === previous.activeId) return;
  const tab = state.tabs.find((t) => t.id === state.activeId);
  const connectionId = useSessionStore.getState().activeConnectionId;
  if (tab?.kind === "table" && connectionId) {
    useRecents
      .getState()
      .add(connectionId, { schema: tab.schema, name: tab.name, kind: tab.objectKind });
  }
});
