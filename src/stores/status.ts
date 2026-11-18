import { create } from "zustand";

/** What the status bar shows about the tab in front. Tabs publish it; nothing else writes it. */
interface StatusState {
  rowCount: { count: number; exact: boolean } | null;
  /** How long the last query took, in milliseconds. */
  queryMs: number | null;
  set: (status: Partial<Pick<StatusState, "rowCount" | "queryMs">>) => void;
  clear: () => void;
}

export const useStatusStore = create<StatusState>()((set) => ({
  rowCount: null,
  queryMs: null,
  set: (status) => set(status),
  clear: () => set({ rowCount: null, queryMs: null }),
}));
