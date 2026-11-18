import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { syncSystemTheme } from "@/lib/theme";
import "@/styles/globals.css";

async function start() {
  // `npm run dev` in a plain browser has no Rust backend: use the in-memory mock.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installMockBackend } = await import("@/dev/mockBackend");
    installMockBackend();
  }

  syncSystemTheme();

  const root = document.getElementById("root");
  if (!root) throw new Error("#root element missing in index.html");

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void start();
