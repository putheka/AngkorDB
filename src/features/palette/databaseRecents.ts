import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { pushName } from "@/features/palette/databasePick";

interface DatabaseRecentsState {
  /** Per connection: the databases switched to last, newest first. */
  byConnection: Record<string, string[]>;
  add: (connectionId: string, database: string) => void;
}

/** Whatever is in storage, reduced to lists of strings. */
function readSaved(value: unknown): Record<string, string[]> {
  if (typeof value !== "object" || value === null || !("byConnection" in value)) return {};
  const saved = value.byConnection;
  if (typeof saved !== "object" || saved === null) return {};
  const result: Record<string, string[]> = {};
  for (const [id, list] of Object.entries(saved)) {
    if (Array.isArray(list)) {
      result[id] = list.filter((name): name is string => typeof name === "string");
    }
  }
  return result;
}

export const useDatabaseRecents = create<DatabaseRecentsState>()(
  persist(
    (set) => ({
      byConnection: {},
      add: (connectionId, database) =>
        set((state) => ({
          byConnection: {
            ...state.byConnection,
            [connectionId]: pushName(state.byConnection[connectionId] ?? [], database),
          },
        })),
    }),
    {
      name: "angkordb.recentDatabases",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: ({ byConnection }) => ({ byConnection }),
      merge: (saved, current) => ({ ...current, byConnection: readSaved(saved) }),
    },
  ),
);
