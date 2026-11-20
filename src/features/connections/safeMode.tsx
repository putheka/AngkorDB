import { FingerprintIcon, LockIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { SafeMode } from "@/bindings";

export const SAFE_MODE_INFO: Record<
  SafeMode,
  { label: string; icon: ComponentType<{ className?: string }> }
> = {
  off: { label: "Writes allowed", icon: ShieldOffIcon },
  confirm: { label: "Confirm writes", icon: ShieldCheckIcon },
  "touch-id": { label: "Touch ID for writes", icon: FingerprintIcon },
  "read-only": { label: "Read-only", icon: LockIcon },
};
