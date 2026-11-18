import type { AppError } from "@/bindings";

/** A fake command: receives the arguments `invoke()` was called with. */
export type Handler = (args: Record<string, unknown>) => unknown;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a failed command rejects with (mirrors `AppError` in Rust). */
export function appError(code: string, message: string, extra: Partial<AppError> = {}): AppError {
  return { code, message, pgCode: null, detail: null, hint: null, position: null, ...extra };
}
