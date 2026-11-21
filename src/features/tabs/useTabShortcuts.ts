import { getCurrentWindow } from "@tauri-apps/api/window";

import { useShortcut, useShortcutGroup } from "@/features/shortcuts/registry";
import { closeTab } from "@/features/tabs/closeTabs";
import { useTabsStore } from "@/stores/tabs";

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
  const on = { enabled };
  useShortcut("tabs.new", () => useTabsStore.getState().newQuery(), on);
  // Also with nothing open: ⌘W then closes the window, like any Mac app.
  useShortcut("tabs.close", () => closeFrontTabOrWindow());
  useShortcut("tabs.next", () => useTabsStore.getState().cycle(1), on);
  useShortcut("tabs.previous", () => useTabsStore.getState().cycle(-1), on);
  useShortcutGroup(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `tabs.goto.${n}`),
    (id) => {
      const n = Number(id.slice(id.lastIndexOf(".") + 1));
      const tabs = useTabsStore.getState();
      tabs.activateIndex(n === 9 ? tabs.tabs.length - 1 : n - 1);
    },
    on,
  );
}
