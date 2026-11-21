import { create } from "zustand";

interface BackupDialogState {
  open: boolean;
  /** Which part to show first. */
  mode: "backup" | "restore";
  show: (mode?: "backup" | "restore") => void;
  close: () => void;
}

export const useBackupDialog = create<BackupDialogState>()((set) => ({
  open: false,
  mode: "backup",
  show: (mode = "backup") => set({ open: true, mode }),
  close: () => set({ open: false }),
}));

const KEY = "angkordb.pgToolsDir";

/** The folder with pg_dump the person chose, kept on this Mac (the settings window comes later). */
export function readToolsDir(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeToolsDir(dir: string | null) {
  try {
    if (dir) localStorage.setItem(KEY, dir);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage may be unavailable: the choice then lasts until the dialog closes.
  }
}
