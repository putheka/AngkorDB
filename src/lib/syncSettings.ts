import { useAppearance } from "@/stores/appearance";
import { useEditorPrefs } from "@/stores/editorPrefs";
import { useGeneral } from "@/stores/general";
import { useLayoutStore } from "@/stores/layout";
import { useShortcuts } from "@/stores/shortcuts";

/** Every store that is kept in `localStorage`, which the settings window and the app share. */
const SHARED = [useAppearance, useEditorPrefs, useGeneral, useShortcuts, useLayoutStore];

/**
 * When the other window changes a setting, take it in. `localStorage` tells every window but
 * the one that wrote (the `storage` event), and each store reads its own key again, so a change
 * in the settings window is live in the app, and the other way round, without a reload.
 */
export function syncSettingsAcrossWindows(): () => void {
  const onStorage = (event: StorageEvent) => {
    // `null`: storage was cleared; everything is read again.
    for (const store of SHARED) {
      if (event.key === null || event.key === store.persist.getOptions().name) {
        void store.persist.rehydrate();
      }
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
