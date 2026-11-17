import { invoke } from "@tauri-apps/api/core";

import type { AppError, AppInfo } from "@/types/ipc";

/**
 * Typed wrappers around Tauri commands.
 * Hand-written for now; replaced by generated tauri-specta bindings in ANG-10.
 */
export const ipc = {
  appInfo: () => invoke<AppInfo>("app_info"),
};

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value &&
    typeof value.code === "string" &&
    typeof value.message === "string"
  );
}
