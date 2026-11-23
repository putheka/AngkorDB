/**
 * The native menu bar and the registry (ANG-55): choosing a menu item runs the command of the same
 * id, and the page tells the menu which items have keys now (they follow what the person set) and
 * which can be chosen (a query command is grey while no query tab is open). The menu bar is one
 * for all windows: each page says what it needs, and the app shows the one of the window in use.
 */
import { useEffect } from "react";

import type { MenuUpdate } from "@/bindings";
import { bindingsOf } from "@/features/shortcuts/bindings";
import { MENU_COMMAND_IDS, commandById } from "@/features/shortcuts/commands";
import { toMenuAccelerator } from "@/features/shortcuts/keys";
import { isAvailable, onAvailabilityChange, runCommand } from "@/features/shortcuts/registry";
import { commands } from "@/lib/ipc";
import { listenInWindow, windowLabel } from "@/lib/windowEvents";
import { useShortcuts } from "@/stores/shortcuts";

/** Native → page: a menu item was chosen; the payload is the id of its command. */
const MENU_COMMAND = "menu-command";

/** What the menu should show now: for each item its first key the menu can spell, and whether it is open. */
export function menuUpdates(
  overrides: Record<string, string[]>,
  available: (id: string) => boolean,
): MenuUpdate[] {
  return MENU_COMMAND_IDS.flatMap((id) => {
    const def = commandById(id);
    if (!def) return [];
    const accelerator =
      bindingsOf(def, overrides)
        .map((chord) => toMenuAccelerator(chord))
        .find((spelling) => spelling !== null) ?? null;
    return [{ id, accelerator, enabled: available(id) }];
  });
}

/** Keep the menu bar in step with the registry, and run what it chooses. */
export function useNativeMenu() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // The app sends a chosen item to the window in use only.
    listenInWindow<string>(MENU_COMMAND, (id) => {
      runCommand(id);
    })
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => undefined); // no native app behind the page (browser dev mode)

    // Opening a tab opens and closes several commands at once: tell the menu once.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const updates = menuUpdates(useShortcuts.getState().overrides, isAvailable);
        commands.updateMenu(windowLabel(), updates).catch(() => undefined);
      }, 30);
    };
    push();
    const stopAvailability = onAvailabilityChange(push);
    const stopKeys = useShortcuts.subscribe(push);
    return () => {
      cancelled = true;
      unlisten?.();
      stopAvailability();
      stopKeys();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
}
