import { isAppError } from "@/lib/ipc";

/** One readable message from anything a command can reject with. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Extra lines worth showing under the message: Postgres' detail and hint. */
export function errorDetails(error: unknown): string[] {
  if (!isAppError(error)) return [];
  const lines: string[] = [];
  if (error.detail) lines.push(error.detail);
  if (error.hint) lines.push(`Hint: ${error.hint}`);
  return lines;
}
