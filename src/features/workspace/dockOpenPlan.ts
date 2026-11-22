/** What to do when a connection is chosen in the Dock menu (pure, so it can be tested). */
export type DockOpenPlan =
  /** Already open, or a connection is being opened right now: nothing to do. */
  | "ignore"
  /** The connection was deleted since the menu was built. */
  | "missing"
  /** Open it on the welcome screen. */
  | "connect"
  /** Leave the open connection first (asking about unsaved edits), then open it. */
  | "switch";

export function planDockOpen(
  activeId: string | null,
  connectingId: string | null,
  exists: boolean,
  id: string,
): DockOpenPlan {
  if (activeId === id || connectingId !== null) return "ignore";
  if (!exists) return "missing";
  return activeId === null ? "connect" : "switch";
}
