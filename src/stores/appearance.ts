import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  DEFAULT_APPEARANCE,
  sanitizeAppearance,
  type AppearancePrefs,
} from "@/features/appearance/prefs";

interface AppearanceState extends AppearancePrefs {
  set: (patch: Partial<AppearancePrefs>) => void;
}

/** Light or dark, grid density and fonts, editor colors: one setting for the app, kept across restarts. */
export const useAppearance = create<AppearanceState>()(
  persist(
    (set) => ({
      ...DEFAULT_APPEARANCE,
      set: (patch) => set(patch),
    }),
    {
      name: "angkordb.appearance",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): AppearancePrefs => ({
        mode: s.mode,
        density: s.density,
        gridFont: s.gridFont,
        gridFontSize: s.gridFontSize,
        editorTheme: s.editorTheme,
        translucentSidebar: s.translucentSidebar,
      }),
      merge: (saved, current) => ({ ...current, ...sanitizeAppearance(saved) }),
    },
  ),
);
