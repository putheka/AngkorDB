import { useEffect } from "react";

import { connectionToReopen, startAutosave } from "@/features/workspace/workspace";
import { useSessionStore } from "@/stores/session";

/** Once per launch, however many times React mounts the shell. */
let reopened = false;

/**
 * Keep the open connection's workspace on disk while the app runs, and at launch reopen the
 * connection that was open last time (unless the person turned that off).
 */
export function useWorkspacePersistence() {
  useEffect(() => startAutosave(() => useSessionStore.getState().activeConnectionId), []);
  useEffect(() => {
    if (reopened) return;
    reopened = true;
    void connectionToReopen().then((connection) => {
      const session = useSessionStore.getState();
      if (connection && session.activeConnectionId === null && session.connectingId === null) {
        void session.connect(connection);
      }
    });
  }, []);
}
