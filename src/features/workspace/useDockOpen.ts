import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { commands } from "@/lib/ipc";
import { useSessionStore } from "@/stores/session";
import { planDockOpen } from "./dockOpenPlan";

/** Sent by the app when a connection is chosen in the Dock menu; the payload is its id. */
const DOCK_OPEN_CONNECTION = "dock-open-connection";

async function openFromDock(id: string) {
  const session = useSessionStore.getState();
  const found = await commands
    .listConnections()
    .then((all) => all.find((c) => c.id === id) ?? null)
    .catch(() => null);
  const plan = planDockOpen(session.activeConnectionId, session.connectingId, found !== null, id);
  if (plan === "missing") {
    useSessionStore.setState({ error: "That connection no longer exists." });
    return;
  }
  if (plan === "ignore" || !found) return;
  // The person may choose to stay on the open connection because of unsaved edits.
  if (plan === "switch" && !(await session.disconnect())) return;
  await useSessionStore.getState().connect(found);
}

/** Open the connection chosen in the Dock menu. */
export function useDockOpen() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<string>(DOCK_OPEN_CONNECTION, (event) => void openFromDock(event.payload))
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => undefined); // no native app behind the page (browser dev mode)
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
