import { create } from "zustand";

interface CurrentDatabaseState {
  /** The database each open connection is on now (it starts on the one the connection names). */
  byConnection: Record<string, string>;
  set: (connectionId: string, database: string) => void;
  forget: (connectionId: string) => void;
}

/**
 * Which database each open connection is using. A session can be switched to another database
 * (⌘O); the workspace remembers that, so the next launch opens the same database as its tabs.
 */
export const useCurrentDatabase = create<CurrentDatabaseState>()((set) => ({
  byConnection: {},
  set: (connectionId, database) =>
    set((state) => ({ byConnection: { ...state.byConnection, [connectionId]: database } })),
  forget: (connectionId) =>
    set((state) => ({
      byConnection: Object.fromEntries(
        Object.entries(state.byConnection).filter(([id]) => id !== connectionId),
      ),
    })),
}));
