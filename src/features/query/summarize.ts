import type { StatementOutcome } from "@/bindings";

const number = new Intl.NumberFormat("en-US");

/** Words after which "N rows affected" makes sense; for the rest the count is always 0. */
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "COPY", "SELECT"]);

/** A statement's outcome in a few words, for the chips and the footer. */
export function summarize(outcome: StatementOutcome): string {
  switch (outcome.kind) {
    case "rows":
      return `${number.format(outcome.rows.length)} ${outcome.rows.length === 1 ? "row" : "rows"}`;
    case "command":
      return DML.has(outcome.command)
        ? `${outcome.command} · ${number.format(outcome.affected)} ${outcome.affected === 1 ? "row" : "rows"}`
        : outcome.command || "Done";
    case "error":
      return "Error";
  }
}
