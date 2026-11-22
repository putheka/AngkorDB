import { useEffect } from "react";

import { shouldCheckAtLaunch } from "@/features/updates/updateState";
import { inNativeApp } from "@/lib/native";
import { useGeneral } from "@/stores/general";
import { useUpdates } from "@/stores/updates";

/** Once per launch, a few seconds in (the app is up first), look for a new version if wanted. */
let checked = false;
const LAUNCH_DELAY_MS = 5000;

export function useLaunchUpdateCheck() {
  useEffect(() => {
    if (checked) return;
    const timer = setTimeout(() => {
      if (checked) return;
      checked = true;
      if (shouldCheckAtLaunch(useGeneral.getState().checkForUpdates, inNativeApp())) {
        void useUpdates.getState().check();
      }
    }, LAUNCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}
