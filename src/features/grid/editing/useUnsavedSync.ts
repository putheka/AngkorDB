import { useEffect } from "react";

import { dirtyTabs, useUnsavedTabCount } from "@/features/grid/editing/unsaved";
import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { useQuitConfirm } from "@/stores/quitConfirm";
import { commands } from "@/lib/ipc";
import { listenInWindow, windowLabel } from "@/lib/windowEvents";
import { useGeneral } from "@/stores/general";
import { useSessionStore } from "@/stores/session";

/** Native → this window: ⌘Q was pressed (or the last window closed) while Rust knows of unsaved edits. */
const QUIT_REQUESTED = "quit-requested";
/** Native → this window: its close button was pressed while it has unsaved edits. */
const CLOSE_REQUESTED = "window-close-requested";

/**
 * The page's side of the unsaved-changes guard for the app itself (ANG-29):
 *
 * - Tells Rust how many tabs of this window have staged edits. Rust shows the window's "edited" dot, and holds
 *   back ⌘Q and the close button while there are any.
 * - Answers when Rust holds one back: the same Commit / Discard / Cancel dialog, then quits.
 * - In a browser (dev mode), the browser's own "leave this page?" question on reload.
 */
export function useUnsavedSync() {
  const count = useUnsavedTabCount();
  useEffect(() => {
    // No native app behind the page in browser dev mode: nothing to tell.
    commands.setUnsavedChanges(windowLabel(), count).catch(() => undefined);
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
    const stops: Array<() => void> = [];
    let cancelled = false;
    const on = (event: string, handler: () => Promise<void>) =>
      listenInWindow<unknown>(event, () => void handler())
        .then((stop) => (cancelled ? stop() : stops.push(stop)))
        .catch(() => undefined); // no native app behind the page (browser dev mode)

    on(QUIT_REQUESTED, async () => {
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
        // Rust asks the next window with edits, or leaves.
        await commands.quitApp(windowLabel());
      }
    });
    on(CLOSE_REQUESTED, async () => {
      const connectionId = useSessionStore.getState().activeConnectionId;
      if (await guardUnsaved(connectionId, "close this window")) {
        await commands.closeWindow(windowLabel());
      }
    });
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, []);
}
