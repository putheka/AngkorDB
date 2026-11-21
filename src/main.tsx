import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { Providers } from "@/app/Providers";
import { SettingsApp } from "@/features/settings/SettingsApp";
import { syncSettingsAcrossWindows } from "@/lib/syncSettings";
import { startAppearance } from "@/lib/theme";
import "@/styles/globals.css";

async function start() {
  // `npm run dev` in a plain browser has no Rust backend: use the in-memory mock.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installMockBackend } = await import("@/dev/mockBackend");
    installMockBackend();
  }

  startAppearance();
  // A change made in the settings window (or the app) reaches the other window at once.
  syncSettingsAcrossWindows();
  // The settings window is this same page, opened at `#settings`.
  const settings = window.location.hash === "#settings";

  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing in index.html");

  createRoot(root).render(
    <StrictMode>
      {settings ? (
        <Providers>
          <SettingsApp />
        </Providers>
      ) : (
        <App />
      )}
    </StrictMode>,
  );
}

void start();
