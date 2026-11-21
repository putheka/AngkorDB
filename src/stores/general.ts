import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  DEFAULT_GENERAL,
  sanitizeGeneral,
  type GeneralPrefs,
} from "@/features/settings/generalPrefs";

interface GeneralState extends GeneralPrefs {
  set: (patch: Partial<GeneralPrefs>) => void;
}

/** Launch, quit, paging, how values are written, new-connection defaults: kept across restarts. */
export const useGeneral = create<GeneralState>()(
  persist(
    (set) => ({
      ...DEFAULT_GENERAL,
      set: (patch) => set(patch),
    }),
    {
      name: "angkordb.general",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): GeneralPrefs => ({
        pageSize: s.pageSize,
        confirmOnQuit: s.confirmOnQuit,
        checkForUpdates: s.checkForUpdates,
        nullDisplay: s.nullDisplay,
        dateFormat: s.dateFormat,
        timeZone: s.timeZone,
        defaultSafeMode: s.defaultSafeMode,
      }),
      merge: (saved, current) => ({ ...current, ...sanitizeGeneral(saved) }),
    },
  ),
);
