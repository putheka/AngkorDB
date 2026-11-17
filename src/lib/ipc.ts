import type { AppError } from "@/bindings";

/**
 * Typed Rust commands come from the generated `@/bindings` (tauri-specta).
 * Failed commands reject with an `AppError`; use `isAppError` to narrow a caught value.
 */
export { commands } from "@/bindings";
export type { AppError } from "@/bindings";

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
