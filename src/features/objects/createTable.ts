/**
 * The form of the "new table" wizard (ANG-38) and how it becomes an operation for the backend.
 *
 * Only `import type` from other modules: this runs under plain Node in the unit tests.
 */
import type { ColorTag, ObjectOperation } from "../../bindings.ts";

export type IdentityChoice = "none" | "always" | "byDefault";

export interface ColumnDraft {
  id: number;
  name: string;
  typeName: string;
  nullable: boolean;
  defaultValue: string;
  identity: IdentityChoice;
  primaryKey: boolean;
  comment: string;
}

export type PresetId = "id" | "created_at" | "updated_at";

export const PRESETS: { id: PresetId; label: string }[] = [
  { id: "id", label: "id (bigint, identity, key)" },
  { id: "created_at", label: "created_at (timestamptz, now())" },
  { id: "updated_at", label: "updated_at (timestamptz, now())" },
];

/** A column filled in the way the preset says. */
export function presetColumn(preset: PresetId, id: number): ColumnDraft {
  const base: ColumnDraft = {
    id,
    name: preset,
    typeName: "text",
    nullable: true,
    defaultValue: "",
    identity: "none",
    primaryKey: false,
    comment: "",
  };
  if (preset === "id") {
    return { ...base, typeName: "bigint", nullable: false, identity: "always", primaryKey: true };
  }
  return { ...base, typeName: "timestamp with time zone", nullable: false, defaultValue: "now()" };
}

export function blankColumn(id: number): ColumnDraft {
  return {
    id,
    name: "",
    typeName: "text",
    nullable: true,
    defaultValue: "",
    identity: "none",
    primaryKey: false,
    comment: "",
  };
}

const orNull = (text: string) => (text.trim() === "" ? null : text.trim());

/** The form as the operation the backend plans. */
export function toOperation(
  schema: string,
  name: string,
  comment: string,
  columns: readonly ColumnDraft[],
): ObjectOperation {
  return {
    kind: "createTable",
    schema,
    name: name.trim(),
    comment: comment === "" ? null : comment,
    columns: columns.map((c) => ({
      name: c.name.trim(),
      typeName: c.typeName.trim(),
      nullable: c.nullable && !c.primaryKey,
      defaultValue: c.identity === "none" ? orNull(c.defaultValue) : null,
      identity: c.identity === "none" ? null : c.identity,
      primaryKey: c.primaryKey,
      comment: c.comment === "" ? null : c.comment,
    })),
  };
}

/** What is missing or wrong, before the SQL is asked for. */
export function formProblems(name: string, columns: readonly ColumnDraft[]): string[] {
  const found: string[] = [];
  if (name.trim() === "") found.push("Give the table a name.");
  if (columns.length === 0) found.push("Add at least one column.");
  const seen = new Set<string>();
  for (const c of columns) {
    const column = c.name.trim();
    if (column === "") found.push("A column has no name.");
    else if (seen.has(column)) found.push(`Two columns are called "${column}".`);
    seen.add(column);
    if (c.typeName.trim() === "") found.push(`Column "${column || "?"}" has no type.`);
    if (c.identity !== "none" && !/^(small|big)?int(eger|2|4|8)?$/i.test(c.typeName.trim())) {
      found.push(
        `Column "${column || "?"}": only smallint, integer and bigint can be an identity.`,
      );
    }
    if (c.identity !== "none" && c.defaultValue.trim() !== "") {
      found.push(`Column "${column || "?"}": an identity column can't also have a default.`);
    }
  }
  return [...new Set(found)];
}

/** Dropping or emptying something on a red connection means typing its name first. */
export const needsTypedConfirmation = (color: ColorTag, destructive: boolean) =>
  destructive && color === "red";

export const confirmationMatches = (typed: string, name: string) => typed.trim() === name;
