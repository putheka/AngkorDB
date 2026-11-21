import { create } from "zustand";

import type { ConnectionConfig } from "@/bindings";
import { errorMessage } from "@/lib/errors";
import { guardUnsaved } from "@/features/grid/editing/unsavedGuard";
import { commands } from "@/lib/ipc";
import { queryClient } from "@/lib/queryClient";
import { useBrowserStore } from "@/stores/browser";
import { usePaletteStore } from "@/stores/palette";
import { useStatusStore } from "@/stores/status";
import { useTabsStore } from "@/stores/tabs";

interface SessionState {
  /** The connection currently open, if any. */
  activeConnectionId: string | null;
  serverVersion: string | null;
  /** The connection being opened right now. */
  connectingId: string | null;
  /** Why the last connect failed. */
  error: string | null;
  connect: (connection: ConnectionConfig) => Promise<void>;
  /** `false` when the person chose to stay because of unsaved edits. */
  disconnect: () => Promise<boolean>;
  clearError: () => void;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  activeConnectionId: null,
  serverVersion: null,
  connectingId: null,
  error: null,

  connect: async (connection) => {
    if (get().connectingId) return;
    set({ connectingId: connection.id, error: null });
    try {
      const info = await commands.connectConnection(connection.id);
      set({
        activeConnectionId: connection.id,
        serverVersion: info.serverVersion,
        connectingId: null,
      });
    } catch (error) {
      set({
        connectingId: null,
        error: `Could not connect to “${connection.name}”: ${errorMessage(error)}`,
      });
    }
  },

  disconnect: async () => {
    const id = get().activeConnectionId;
    // Staged edits are lost with the tabs: ask first.
    if (!(await guardUnsaved(id, "disconnect"))) return false;
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
    if (id) await commands.disconnectConnection(id).catch(() => undefined);
    return true;
  },

  clearError: () => set({ error: null }),
}));
