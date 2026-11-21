import { getCurrentWindow } from "@tauri-apps/api/window";

import { resolveDark } from "@/features/appearance/prefs";
import { useAppearance } from "@/stores/appearance";

/** The real app has window metadata; the browser mock of `npm run dev` only fakes `invoke`. */
const inNativeApp = () => {
  const internals = (window as { __TAURI_INTERNALS__?: { metadata?: unknown } })
    .__TAURI_INTERNALS__;
  return Boolean(internals?.metadata);
};

/**
 * Keep <html> in step with the appearance settings (ANG-51): the `dark` class that the color
 * tokens switch on, the editor's syntax colors, and the sidebar's translucency. In "system" mode
 * the app follows macOS, live: no reload when the appearance changes. In the native app the
 * window's own theme follows too, so the title bar, menus and system dialogs match.
 */
export function startAppearance(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  const apply = () => {
    const prefs = useAppearance.getState();
    const root = document.documentElement;
    const dark = resolveDark(prefs.mode, media.matches);
    root.classList.toggle("dark", dark);
    root.dataset["editorTheme"] = prefs.editorTheme;
    // Without the native window behind it there is nothing to see through to.
    root.classList.toggle("translucent-sidebar", prefs.translucentSidebar && inNativeApp());
    root.dataset["density"] = prefs.density;
    if (inNativeApp()) {
      // `null` hands the window back to macOS.
      try {
        void getCurrentWindow()
          .setTheme(prefs.mode === "system" ? null : prefs.mode)
          .catch(() => undefined);
      } catch {
        // No window to tell: the page still follows the setting.
      }
    }
  };

  apply();
  media.addEventListener("change", apply);
  const stop = useAppearance.subscribe(apply);
  return () => {
    media.removeEventListener("change", apply);
    stop();
  };
}
