import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

import {
  afterDownloadEvent,
  updateErrorMessage,
  type UpdateStatus,
} from "@/features/updates/updateState";

interface UpdatesState {
  status: UpdateStatus;
  /** Look for a new version. `manual`: the person asked, so "up to date" is shown too. */
  check: (options?: { manual?: boolean }) => Promise<void>;
  /** Download the version found, install it, and restart into it. */
  install: () => Promise<void>;
  dismiss: () => void;
}

/** The update found by the last check: the plugin's object isn't state a screen should hold. */
let found: Update | null = null;

export const useUpdates = create<UpdatesState>()((set, get) => ({
  status: { kind: "idle" },

  check: async ({ manual = false } = {}) => {
    const now = get().status.kind;
    if (now === "checking" || now === "downloading") return;
    set({ status: { kind: "checking", manual } });
    try {
      found = await check();
      if (found) {
        set({ status: { kind: "available", version: found.version, notes: found.body ?? null } });
      } else {
        // At launch nothing is said when there is nothing new.
        set({ status: manual ? { kind: "upToDate" } : { kind: "idle" } });
      }
    } catch (error) {
      // A check nobody asked for fails quietly (offline, no release yet).
      set({
        status: manual ? { kind: "error", message: updateErrorMessage(error) } : { kind: "idle" },
      });
    }
  },

  install: async () => {
    const status = get().status;
    if (status.kind !== "available" || !found) return;
    set({
      status: { kind: "downloading", version: status.version, downloaded: 0, total: null },
    });
    try {
      await found.downloadAndInstall((event) =>
        set((state) => ({ status: afterDownloadEvent(state.status, event) })),
      );
      set({ status: { kind: "ready", version: status.version } });
      await relaunch();
    } catch (error) {
      set({ status: { kind: "error", message: updateErrorMessage(error) } });
    }
  },

  dismiss: () => set({ status: { kind: "idle" } }),
}));
