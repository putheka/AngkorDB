import { create } from "zustand";

import type { ConnectionConfig } from "@/bindings";
import { hostKeyStop, type HostKeyStop } from "@/features/connections/hostKey";
import { errorMessage } from "@/lib/errors";
import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { useBrowserStore } from "@/stores/browser";
import { usePaletteStore } from "@/stores/palette";
import { useStatusStore } from "@/stores/status";
import { useTabsStore } from "@/stores/tabs";
import { restoreWorkspace, saveWorkspaceNow } from "@/features/workspace/workspace";

interface SessionState {
  /** The connection currently open, if any. */
  activeConnectionId: string | null;
  serverVersion: string | null;
  /** The connection being opened right now. */
  connectingId: string | null;
  /** Why the last connect failed. */
  error: string | null;
  /** The SSH server's host key that the last connect stopped at, waiting to be trusted or not. */
  hostKey: { connection: ConnectionConfig; stop: HostKeyStop } | null;
  connect: (connection: ConnectionConfig) => Promise<void>;
  /** Trust the host key the connect stopped at, then connect again. */
  trustHostKey: () => Promise<void>;
  dismissHostKey: () => void;
  /** `false` when the person chose to stay because of unsaved edits. */
  disconnect: () => Promise<boolean>;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  activeConnectionId: null,
  serverVersion: null,
  connectingId: null,
  error: null,
  hostKey: null,

  connect: async (connection) => {
    if (get().connectingId) return;
    set({ connectingId: connection.id, error: null, hostKey: null });
    try {
      const info = await commands.connectConnection(connection.id);
      set({
        activeConnectionId: connection.id,
        serverVersion: info.serverVersion,
        connectingId: null,
      });
      // Note which connection to reopen at the next launch, and bring its tabs back.
      void commands.setLastConnection(connection.id).catch(() => undefined);
      await restoreWorkspace(connection.id);
    } catch (error) {
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

  disconnect: async () => {
    const id = get().activeConnectionId;
    // Staged edits are lost with the tabs: ask first.
    if (!(await guardUnsaved(id, "disconnect"))) return false;
    // Keep what is open for next time before the tabs go; a disconnect is not "start over".
    if (id) await saveWorkspaceNow(id);
    // Leave the screen first; closing the server side can't fail in a way the user can act on.
    set({ activeConnectionId: null, serverVersion: null });
    useStatusStore.getState().clear();
    usePaletteStore.getState().close();
    useTabsStore.getState().closeAll();
    useBrowserStore.getState().setSchema(null);
    if (id) {
      queryClient.removeQueries({ queryKey: ["schema", id] });
      queryClient.removeQueries({ queryKey: ["data", id] });
    }
    // Leaving on purpose: the next launch starts at the welcome screen.
    void commands.setLastConnection(null).catch(() => undefined);
    if (id) await commands.disconnectConnection(id).catch(() => undefined);
    return true;
  },

  clearError: () => set({ error: null }),
}));
