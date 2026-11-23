import { useEffect } from "react";

import { commands } from "@/lib/ipc";
import { windowLabel } from "@/lib/windowEvents";
import { connectionToReopen, startAutosave } from "@/features/workspace/workspace";
import { windowStart } from "@/features/workspace/windowStart";
import { useSessionStore } from "@/stores/session";
import { useWelcome } from "@/stores/welcome";

/** Once per window, however many times React mounts the shell. */
let started = false;

/**
 * Keep the open connection's workspace on disk while the app runs, and when the window opens do
 * what it was opened for: the first window reopens the connection that was open last time (unless
 * the person turned that off); another window opens the connection it was made for, shows the
 * new-connection form, or stays on the welcome screen.
 */
export function useWorkspacePersistence() {
  useEffect(() => startAutosave(() => useSessionStore.getState().activeConnectionId), []);
  useEffect(() => {
    if (started) return;
    started = true;
    const start = windowStart(windowLabel(), window.location.hash);
    if (start.kind === "welcome") return;
    if (start.kind === "new") {
      useWelcome.getState().requestNewConnection();
      return;
    }
    const wanted =
      start.kind === "restore"
        ? connectionToReopen()
        : commands
            .listConnections()
            .then((all) => all.find((c) => c.id === start.id) ?? null)
            .catch(() => null);
    void wanted.then((connection) => {
      const session = useSessionStore.getState();
      if (connection && session.activeConnectionId === null && session.connectingId === null) {
        void session.connect(connection);
      }
    });
  }, []);
}
