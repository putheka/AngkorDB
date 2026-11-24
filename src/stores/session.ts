import { create } from "zustand";

import type { ConnectionConfig } from "@/bindings";
import { frontAfterClose } from "@/features/connections/rail";
import { hostKeyStop, type HostKeyStop } from "@/features/connections/hostKey";
import { errorMessage } from "@/lib/errors";
import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { MAIN_WINDOW, windowLabel } from "@/lib/windowEvents";
import { useBrowserStore } from "@/stores/browser";
import { useCurrentDatabase } from "@/stores/currentDatabase";
import { usePaletteStore } from "@/stores/palette";
import { useStatusStore } from "@/stores/status";
import { useTabsStore } from "@/stores/tabs";
import { restoreWorkspace, saveWorkspaceNow } from "@/features/workspace/workspace";

interface SessionState {
  /** The connection in front, if any. */
  activeConnectionId: string | null;
  /**
   * Every connection open in this window, in the order they were opened (the strip on the left).
   * The one in front shows its tabs; the others wait with their workspace kept on disk.
   */
  openIds: string[];
  /** The server version of each open connection. */
  versions: Record<string, string>;
  serverVersion: string | null;
  /** The connection being opened right now. */
  connectingId: string | null;
  /** Why the last connect failed. */
  error: string | null;
  /** The SSH server's host key that the last connect stopped at, waiting to be trusted or not. */
  hostKey: { connection: ConnectionConfig; stop: HostKeyStop } | null;
  /** Open a connection (or bring it to the front if it is open) and show it. */
  connect: (connection: ConnectionConfig) => Promise<void>;
  /** Bring an open connection to the front. `false` when the person chose to stay. */
  activate: (id: string) => Promise<boolean>;
  /** Leave the front connection for the list of connections; every connection stays open. */
  showConnections: () => Promise<boolean>;
  /** Close one open connection. `false` when the person chose to stay because of unsaved edits. */
  closeConnection: (id: string) => Promise<boolean>;
  /** Trust the host key the connect stopped at, then connect again. */
  trustHostKey: () => Promise<void>;
  dismissHostKey: () => void;
  /** Close the front connection. `false` when the person chose to stay because of unsaved edits. */
  disconnect: () => Promise<boolean>;
  clearError: () => void;
}

/** Note which connection to reopen at the next launch (and for the Dock's list). */
function rememberAsLast(id: string | null) {
  if (id === null && windowLabel() !== MAIN_WINDOW) return;
  void commands.setLastConnection(id).catch(() => undefined);
}

export const useSessionStore = create<SessionState>()((set, get) => {
  /**
   * Take the front connection off the screen: ask about staged edits (they are lost with the
   * tabs), keep what is open for next time, clear what the screen holds for it. `false` when the
   * person chose to stay.
   */
  async function leaveFront(verb: string): Promise<boolean> {
    const id = get().activeConnectionId;
    if (!id) return true;
    if (!(await guardUnsaved(id, verb))) return false;
    // A switch is not "start over": the tabs come back when the connection does.
    await saveWorkspaceNow(id);
    useStatusStore.getState().clear();
    usePaletteStore.getState().close();
    useTabsStore.getState().closeAll();
    useBrowserStore.getState().setSchema(null);
    return true;
  }

  async function show(id: string) {
    set({ activeConnectionId: id, serverVersion: get().versions[id] ?? null });
    rememberAsLast(id);
    await restoreWorkspace(id);
  }

  return {
    activeConnectionId: null,
    openIds: [],
    versions: {},
    serverVersion: null,
    connectingId: null,
    error: null,
    hostKey: null,

    connect: async (connection) => {
      if (get().connectingId) return;
      if (get().openIds.includes(connection.id)) {
        await get().activate(connection.id);
        return;
      }
      set({ connectingId: connection.id, error: null, hostKey: null });
      const label = windowLabel();
      try {
        // A connection is open in one window at a time (its session is one for the whole app).
        // When another window has it, that window is brought forward and this one stays as it is.
        if (!(await commands.claimConnection(label, connection.id))) {
          set({
            connectingId: null,
            error: `“${connection.name}” is already open in another window. It is in front now.`,
          });
          return;
        }
        const info = await commands.connectConnection(connection.id);
        useCurrentDatabase.getState().set(connection.id, connection.database);
        set((s) => ({
          openIds: [...s.openIds, connection.id],
          versions: { ...s.versions, [connection.id]: info.serverVersion },
          connectingId: null,
        }));
        // The connection that was in front waits in the strip. If the person wants to finish
        // something there first, the new one is open and waits too.
        if (!(await leaveFront("switch connection"))) return;
        await show(connection.id);
      } catch (error) {
        void commands.releaseConnection(label, connection.id).catch(() => undefined);
        const stop = hostKeyStop(error);
        if (stop?.kind === "unknown") {
          // Not a failure yet: the person decides whether this is the server they mean.
          set({ connectingId: null, hostKey: { connection, stop } });
          return;
        }
        set({
          connectingId: null,
          error: `Could not connect to “${connection.name}”: ${errorMessage(error)}`,
        });
      }
    },

    activate: async (id) => {
      if (id === get().activeConnectionId) return true;
      if (!get().openIds.includes(id)) return false;
      if (!(await leaveFront("switch connection"))) return false;
      await show(id);
      return true;
    },

    showConnections: async () => {
      if (!(await leaveFront("leave this connection"))) return false;
      set({ activeConnectionId: null, serverVersion: null });
      return true;
    },

    trustHostKey: async () => {
      const pending = get().hostKey;
      if (!pending) return;
      try {
        await commands.trustSshHost(pending.stop.fingerprint);
      } catch (error) {
        set({ hostKey: null, error: errorMessage(error) });
        return;
      }
      set({ hostKey: null });
      await get().connect(pending.connection);
    },

    dismissHostKey: () => set({ hostKey: null }),

    closeConnection: async (id) => {
      if (!get().openIds.includes(id)) return true;
      const wasFront = id === get().activeConnectionId;
      if (wasFront && !(await leaveFront("disconnect"))) return false;
      const next = wasFront ? frontAfterClose(get().openIds, id) : get().activeConnectionId;
      set((s) => {
        const versions = Object.fromEntries(
          Object.entries(s.versions).filter(([key]) => key !== id),
        );
        return {
          openIds: s.openIds.filter((open) => open !== id),
          versions,
          ...(wasFront ? { activeConnectionId: null, serverVersion: null } : {}),
        };
      });
      queryClient.removeQueries({ queryKey: ["schema", id] });
      queryClient.removeQueries({ queryKey: ["data", id] });
      useCurrentDatabase.getState().forget(id);
      // Leaving on purpose: the next launch starts at the welcome screen.
      if (next === null) rememberAsLast(null);
      void commands.releaseConnection(windowLabel(), id).catch(() => undefined);
      void commands.disconnectConnection(id).catch(() => undefined);
      if (wasFront && next) await show(next);
      return true;
    },

    disconnect: async () => {
      const id = get().activeConnectionId;
      return id ? get().closeConnection(id) : true;
    },

    clearError: () => set({ error: null }),
  };
});
