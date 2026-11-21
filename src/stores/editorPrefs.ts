import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { DEFAULT_PREFS, sanitizePrefs, type EditorPrefs } from "@/features/query/prefs";

interface EditorPrefsState extends EditorPrefs {
  set: (patch: Partial<EditorPrefs>) => void;
}

/** How the SQL editor looks and behaves; one setting for every query tab, kept across restarts. */
export const useEditorPrefs = create<EditorPrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      set: (patch) => set(patch),
    }),
    {
      name: "angkordb.editor",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): EditorPrefs => ({
        fontFamily: s.fontFamily,
        fontSize: s.fontSize,
        tabSize: s.tabSize,
        lineNumbers: s.lineNumbers,
        wordWrap: s.wordWrap,
        vim: s.vim,
        keywordCase: s.keywordCase,
      }),
      merge: (saved, current) => ({ ...current, ...sanitizePrefs(saved) }),
    },
  ),
);
