import type { ColumnInfo } from "@/bindings";

/** Which editor a column gets, from its Postgres type. */
export type EditorKind =
  | "text"
  | "json"
  | "bool"
  | "integer"
  | "decimal"
  | "uuid"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  /** A type made by the user: an enum gets a dropdown, anything else falls back to text. */
  | "userType";

/** First OID Postgres hands out to objects created by users. */
const FIRST_USER_OID = 16384;

export function editorKindOf(column: Pick<ColumnInfo, "typeOid">): EditorKind {
  switch (column.typeOid) {
    case 16:
      return "bool";
    case 20:
    case 21:
    case 23:
    case 26:
      return "integer";
    case 700:
    case 701:
    case 1700:
      return "decimal";
    case 2950:
      return "uuid";
    case 1082:
      return "date";
    case 1083:
    case 1266:
      return "time";
    case 1114:
      return "timestamp";
    case 1184:
      return "timestamptz";
    case 114:
    case 3802:
      return "json";
    default:
      return column.typeOid >= FIRST_USER_OID ? "userType" : "text";
  }
}

/** Generated columns can't be written, and `GENERATED ALWAYS AS IDENTITY` refuses updates. */
export const isEditableColumn = (column: ColumnInfo) =>
  !column.generated && column.identity !== "always";

const INTEGER_RANGES: Record<number, { name: string; min: bigint; max: bigint }> = {
  21: { name: "smallint", min: -(2n ** 15n), max: 2n ** 15n - 1n },
  23: { name: "integer", min: -(2n ** 31n), max: 2n ** 31n - 1n },
  20: { name: "bigint", min: -(2n ** 63n), max: 2n ** 63n - 1n },
  26: { name: "oid", min: 0n, max: 2n ** 32n - 1n },
};

const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const SPECIAL_DECIMAL = /^[+-]?(nan|infinity|inf)$/i;

/** Number types are trimmed (Postgres ignores the spaces); everything else is kept exactly. */
export function normalize(kind: EditorKind, text: string): string {
  return kind === "integer" || kind === "decimal" ? text.trim() : text;
}

/**
 * What is wrong with `text` for this column, or `null`. Only what can be told without asking
 * the server: numbers are checked as text (never through a JS number, which would round),
 * dates and anything else the server knows better are left to it when the change is applied.
 */
export function validate(kind: EditorKind, typeOid: number, text: string): string | null {
  const value = normalize(kind, text);
  switch (kind) {
    case "integer": {
      if (!/^[+-]?\d+$/.test(value)) return "Enter a whole number, or set NULL.";
      const range = INTEGER_RANGES[typeOid];
      if (range) {
        const n = BigInt(value);
        if (n < range.min || n > range.max) {
          return `Out of range for ${range.name} (${range.min} to ${range.max}).`;
        }
      }
      return null;
    }
    case "decimal":
      return DECIMAL.test(value) || SPECIAL_DECIMAL.test(value)
        ? null
        : "Enter a number, or set NULL.";
    case "uuid":
      return /^[0-9a-f]{32}$/i.test(value.replace(/[{}-]/g, "")) ? null : "That is not a UUID.";
    case "json":
      try {
        JSON.parse(value);
        return null;
      } catch (error) {
        return `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      }
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
      return value.trim() === "" ? "Enter a value, or set NULL." : null;
    default:
      return null;
  }
}
