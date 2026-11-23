/** What to do when a connection is chosen in the Dock menu (pure, so it can be tested). */
export type DockOpenPlan =
  /** Already in front, or a connection is being opened right now: nothing to do. */
  | "ignore"
  /** The connection was deleted since the menu was built. */
  | "missing"
  /** Open it (or bring it to the front if it is open): the others stay open in the strip. */
  | "connect";

export function planDockOpen(
  activeId: string | null,
  connectingId: string | null,
  exists: boolean,
  id: string,
): DockOpenPlan {
  if (activeId === id || connectingId !== null) return "ignore";
  return exists ? "connect" : "missing";
}
