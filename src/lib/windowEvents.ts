import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

/** The window made by the app's configuration. Browser dev mode is always this one. */
export const MAIN_WINDOW = "main";

/** The label of the window this page is in. */
export function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    // No native app behind the page (browser dev mode).
    return MAIN_WINDOW;
  }
}

/**
 * Listen for an event sent to this window only (menu commands, the Dock, quitting). Plain
 * `listen` would miss them: the app sends them to one window, not to all.
 */
export function listenInWindow<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  try {
    return getCurrentWebviewWindow().listen<T>(event, (e) => handler(e.payload));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
