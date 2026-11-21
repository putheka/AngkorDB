import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

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

/** ⌘T new query · ⌘W close · ⌘1–9 jump (⌘9 = last) · ⌃Tab and ⌘⇧[ ⌘⇧] cycle. */
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

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const tabs = useTabsStore.getState();

      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
        e.preventDefault();
        tabs.cycle(e.shiftKey ? -1 : 1);
        return;
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return;

      // `code`, not `key`: ⇧[ types "{" on a US keyboard and something else elsewhere.
      if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        tabs.cycle(e.code === "BracketRight" ? 1 : -1);
      } else if (e.shiftKey) {
        return;
      } else if (e.code === "KeyT") {
        e.preventDefault();
        tabs.newQuery();
      } else if (e.code === "KeyW") {
        e.preventDefault();
        closeFrontTabOrWindow();
      } else if (/^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        const n = Number(e.code.slice(5));
        tabs.activateIndex(n === 9 ? tabs.tabs.length - 1 : n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
