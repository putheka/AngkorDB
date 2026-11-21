import type { StatementResult } from "../../bindings.ts";

/** Which result is shown under the editor. */
export type ResultTab =
  | { kind: "messages" }
  /** The result of statement `index` of the last run: only statements that returned rows have one. */
  | { kind: "result"; index: number }
  /** A result kept from an earlier run. */
  | { kind: "pinned"; id: number };

export const sameTab = (a: ResultTab, b: ResultTab): boolean =>
  a.kind === b.kind &&
  (a.kind === "messages" ||
    (a.kind === "result" && b.kind === "result" && a.index === b.index) ||
    (a.kind === "pinned" && b.kind === "pinned" && a.id === b.id));

/** The statements of a run that returned rows, with the number their tab shows ("Result 2"). */
export function resultsOf(
  statements: readonly StatementResult[],
): { index: number; number: number; rows: number }[] {
  const found: { index: number; number: number; rows: number }[] = [];
  statements.forEach((s, index) => {
    if (s.outcome.kind === "rows") {
      found.push({ index, number: found.length + 1, rows: s.outcome.rows.length });
    }
  });
  return found;
}

/**
 * What to show after a run: the failure (in Messages) if the script stopped on one, else the last
 * result that returned rows, else Messages (an `UPDATE` has nothing but a message).
 */
export function pickTab(statements: readonly StatementResult[]): ResultTab {
  if (statements[statements.length - 1]?.outcome.kind === "error") return { kind: "messages" };
  const results = resultsOf(statements);
  const last = results[results.length - 1];
  return last ? { kind: "result", index: last.index } : { kind: "messages" };
}

/** How many things Messages has to say: notices and errors (the badge on its tab). */
export function messageCount(statements: readonly StatementResult[]): number {
  return statements.reduce(
    (n, s) => n + s.notices.length + (s.outcome.kind === "error" ? 1 : 0),
    0,
  );
}
