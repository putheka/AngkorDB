import { lazy, Suspense } from "react";

import { Providers } from "@/app/Providers";

// Only the settings window loads the settings screen.
const SettingsApp = lazy(() =>
  import("@/features/settings/SettingsApp").then((m) => ({ default: m.SettingsApp })),
);

/** The page of the settings window (`#settings`). */
export function SettingsEntry() {
  return (
    <Providers>
      <Suspense fallback={null}>
        <SettingsApp />
      </Suspense>
    </Providers>
  );
}
