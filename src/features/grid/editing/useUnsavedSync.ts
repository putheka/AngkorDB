import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { dirtyTabs, useUnsavedTabCount } from "@/features/grid/editing/unsaved";
import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { useQuitConfirm } from "@/stores/quitConfirm";
import { commands } from "@/lib/ipc";
import { useGeneral } from "@/stores/general";
import { useSessionStore } from "@/stores/session";

/** Native → page: ⌘Q or the close button was pressed while Rust knows of unsaved edits. */
const QUIT_REQUESTED = "quit-requested";

/**
 * The page's side of the unsaved-changes guard for the app itself (ANG-29):
 *
 * - Tells Rust how many tabs have staged edits. Rust shows the window's "edited" dot, and holds
 *   back ⌘Q and the close button while there are any.
 * - Answers when Rust holds one back: the same Commit / Discard / Cancel dialog, then quits.
 * - In a browser (dev mode), the browser's own "leave this page?" question on reload.
 */
export function useUnsavedSync() {
  const count = useUnsavedTabCount();
  useEffect(() => {
    // No native app behind the page in browser dev mode: nothing to tell.
    commands.setUnsavedChanges(count).catch(() => undefined);
  }, [count]);

  // "Confirm on quit" (ANG-53): Rust holds back every quit while it is on.
  const confirmOnQuit = useGeneral((s) => s.confirmOnQuit);
  useEffect(() => {
    commands.setConfirmOnQuit(confirmOnQuit).catch(() => undefined);
  }, [confirmOnQuit]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyTabs().length === 0) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen(QUIT_REQUESTED, async () => {
      const connectionId = useSessionStore.getState().activeConnectionId;
      // With edits the dialog above asked already; "Confirm on quit" asks the plain question
      // only when there was nothing to save.
      const hadEdits = dirtyTabs().length > 0;
      if (!(await guardUnsaved(connectionId, "quit"))) return;
      if (
        hadEdits ||
        !useGeneral.getState().confirmOnQuit ||
        (await useQuitConfirm.getState().ask())
      ) {
        await commands.quitApp();
      }
    })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
