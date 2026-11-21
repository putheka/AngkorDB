import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  assignChord,
  removeChord,
  resetCommand,
  sanitizeOverrides,
  type AssignResult,
  type Overrides,
} from "@/features/shortcuts/bindings";
import { COMMANDS } from "@/features/shortcuts/commands";

interface ShortcutsState {
  /** The keys the person chose in place of the defaults, per command. */
  overrides: Overrides;
  /** The "Keyboard shortcuts" window is showing. */
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  toggleDialog: () => void;
  /** Give a command another key; a conflict is refused unless `replace`. */
  assign: (id: string, chord: string, replace?: boolean) => AssignResult;
  remove: (id: string, chord: string) => void;
  reset: (id: string) => void;
  resetAll: () => void;
}

/** Which keys run which command: the defaults and the changes, kept across restarts. */
export const useShortcuts = create<ShortcutsState>()(
  persist(
    (set, get) => ({
      overrides: {},
      dialogOpen: false,
      openDialog: () => set({ dialogOpen: true }),
      closeDialog: () => set({ dialogOpen: false }),
      toggleDialog: () => set({ dialogOpen: !get().dialogOpen }),
      assign: (id, chord, replace = false) => {
        const result = assignChord(COMMANDS, get().overrides, id, chord, replace);
        if (result.ok) set({ overrides: result.overrides });
        return result;
      },
      remove: (id, chord) => set({ overrides: removeChord(COMMANDS, get().overrides, id, chord) }),
      reset: (id) => set({ overrides: resetCommand(get().overrides, id) }),
      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: "angkordb.shortcuts",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ overrides: s.overrides }),
      merge: (saved, current) => ({
        ...current,
        overrides: sanitizeOverrides(
          COMMANDS,
          typeof saved === "object" && saved !== null && "overrides" in saved
            ? saved.overrides
            : undefined,
        ),
      }),
    },
  ),
);
