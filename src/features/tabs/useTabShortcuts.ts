import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

import { useShortcut } from "@/features/shortcuts/registry";
import { closeTab } from "@/features/tabs/closeTabs";
import { useTabsStore } from "@/stores/tabs";

/** Native menu → page: the "Close Tab" item (⌘W) in `src-tauri/src/menu.rs`. */
const CLOSE_TAB_EVENT = "close-tab";

let lastClose = 0;

/** ⌘W: close the front tab; with none open, close the window like any Mac app. */
export function closeFrontTabOrWindow() {
  // The menu and the keydown handler can both see one key press: close once.
  const now = Date.now();
  if (now - lastClose < 100) return;
  lastClose = now;

  const { activeId } = useTabsStore.getState();
  if (activeId) void closeTab(activeId);
  else {
    try {
      void getCurrentWindow()
        .close()
        .catch(() => undefined);
    } catch {
      // Browser dev mode: there is no native window to close.
    }
  }
}

/** New query, close, jump to a tab (the last one for 9) and cycle: see `commands.ts` for the keys. */
export function useTabShortcuts(enabled: boolean) {
  useEffect(() => {
    // ⌘W arrives as a menu event in the app (the menu owns that key), as a keydown in a browser.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen(CLOSE_TAB_EVENT, closeFrontTabOrWindow)
      .then((stop) => (cancelled ? stop() : (unlisten = stop)))
      .catch(() => undefined); // no native app behind the page (browser dev mode)
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const on = { enabled };
  useShortcut("tabs.new", () => useTabsStore.getState().newQuery(), on);
  useShortcut("tabs.close", () => closeFrontTabOrWindow(), on);
  useShortcut("tabs.next", () => useTabsStore.getState().cycle(1), on);
  useShortcut("tabs.previous", () => useTabsStore.getState().cycle(-1), on);
  for (let n = 1; n <= 9; n++) {
    // The count of commands is fixed, so the hooks always run in the same order.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useShortcut(
      `tabs.goto.${n}`,
      () => {
        const tabs = useTabsStore.getState();
        tabs.activateIndex(n === 9 ? tabs.tabs.length - 1 : n - 1);
      },
      on,
    );
  }
}
