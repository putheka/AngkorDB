import { create } from "zustand";

/** Where the import dialog was opened from: a table, or a new one in a schema. */
export interface ImportSeed {
  schema: string;
  /** The table to import into; `null`: the file becomes a new table. */
  table: string | null;
  /** A file already chosen (dropped on the window). */
  path?: string;
}

interface ImportDialogState {
  seed: ImportSeed | null;
  open: (seed: ImportSeed) => void;
  close: () => void;
}

export const useImportDialog = create<ImportDialogState>()((set) => ({
  seed: null,
  open: (seed) => set({ seed }),
  close: () => set({ seed: null }),
}));
