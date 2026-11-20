import { useCallback } from "react";
import { create } from "zustand";

import type { SafeMode } from "@/bindings";
import { useConnections } from "@/features/connections/useConnections";
import { commands, isAppError } from "@/lib/ipc";

/** What the person is about to approve. */
export interface ApprovalRequest {
  /** "Save changes to Production?" */
  title: string;
  /** What will happen, one line each. */
  lines: string[];
  /** For the Touch ID sheet, which finishes "AngkorDB is trying to …": "save changes to Production". */
  reason: string;
}

interface ApprovalState {
  request: ApprovalRequest | null;
  ask: (request: ApprovalRequest) => Promise<boolean>;
  answer: (approved: boolean) => void;
}

let waiting: ((approved: boolean) => void) | null = null;

/** The confirm dialog (Confirm mode). `WriteApprovalDialog` shows it. */
export const useApprovalStore = create<ApprovalState>()((set) => ({
  request: null,
  ask: (request) =>
    new Promise((resolve) => {
      waiting?.(false); // a new question replaces an unanswered one
      waiting = resolve;
      set({ request });
    }),
  answer: (approved) => {
    const done = waiting;
    waiting = null;
    set({ request: null });
    done?.(approved);
  },
}));

/**
 * Ask before something changes data, as the connection's safe mode says (ANG-25):
 *
 * - **off**: yes.
 * - **confirm**: a dialog.
 * - **touch-id**: the macOS sheet (Touch ID or the Mac password). Cancelling is "no"; any other
 *   failure (no password set, too many tries) is thrown.
 * - **read-only**: yes. Nothing is stopped here: the server refuses the write.
 *
 * This guards against accidents. The app asks itself, so it is not a lock against someone with
 * access to the machine.
 */
export async function approveWrite(mode: SafeMode, request: ApprovalRequest): Promise<boolean> {
  if (mode === "confirm") return useApprovalStore.getState().ask(request);
  if (mode === "touch-id") {
    try {
      await commands.authenticateUser(request.reason);
      return true;
    } catch (error) {
      if (isAppError(error) && error.code === "CANCELLED") return false;
      throw error;
    }
  }
  return true;
}

/** The safe mode of a connection and `approveWrite` bound to it. */
export function useWriteApproval(connectionId: string) {
  const { data: connections = [] } = useConnections();
  const connection = connections.find((c) => c.id === connectionId);
  const mode = connection?.safeMode ?? "off";
  const approve = useCallback((request: ApprovalRequest) => approveWrite(mode, request), [mode]);
  return { mode, name: connection?.name ?? "this database", approve };
}
