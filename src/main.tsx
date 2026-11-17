import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import { syncSystemTheme } from "@/lib/theme";
import "@/styles/globals.css";

syncSystemTheme();

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing in index.html");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
