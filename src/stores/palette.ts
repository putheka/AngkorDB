import { create } from "zustand";

/**
 * `objects` (⌘P): find a table, view or function. `commands` (⌘K): run a command, or switch
 * database, schema, connection. `databases` (⌘O, or the database button of the sidebar): switch
 * database.
 */
export type PaletteMode = "objects" | "commands" | "databases";

interface PaletteState {
  mode: PaletteMode | null;
  open: (mode: PaletteMode) => void;
  close: () => void;
  /** The shortcut: open that mode, close it if it is already showing. */
  toggle: (mode: PaletteMode) => void;
}

export const usePaletteStore = create<PaletteState>()((set, get) => ({
  mode: null,
  open: (mode) => set({ mode }),
  close: () => set({ mode: null }),
  toggle: (mode) => set({ mode: get().mode === mode ? null : mode }),
}));
