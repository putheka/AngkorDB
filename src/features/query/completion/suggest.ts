/**
 * What to offer for a place in a SQL statement (ANG-30): tables, columns of the tables the
 * statement uses, functions. Pure functions over an index of the schema.
 */
import type { CompletionSchema } from "../../../bindings.ts";
import type { CompletionContext, TableRef } from "./analyze.ts";
import { BUILTIN_FUNCTIONS } from "./functions.ts";

export type SuggestionType = "table" | "view" | "column" | "function" | "schema" | "alias";

export interface Suggestion {
  /** What the list shows. */
  label: string;
  /** What is written: the label, quoted if the name needs it. */
  insert: string;
  type: SuggestionType;
  /** Grey text next to the label: a column's type, a function's signature. */
  detail?: string;
  /** Higher comes first when the typed text matches equally well. */
  boost?: number;
  /** A function: the cursor goes between the parentheses (or after them when it takes nothing). */
  call?: "args" | "none";
}

type Table = CompletionSchema["tables"][number];

/** The schema ready for lookups. Built once per schema, used for every keystroke. */
export interface SchemaIndex {
  schema: CompletionSchema;
  /** Table name (lower case) → every table with it, in search path order first. */
  byName: Map<string, Table[]>;
  schemas: string[];
  inPath: Set<string>;
}

/** Names that are plain lower-case words need no quotes; anything else does. */
export function quoteIfNeeded(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) && !RESERVED.has(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

const RESERVED = new Set([
  "all",
  "analyse",
  "analyze",
  "and",
  "any",
  "array",
  "as",
  "asc",
  "both",
  "case",
  "cast",
  "check",
  "collate",
  "column",
  "constraint",
  "create",
  "current_date",
  "current_time",
  "current_timestamp",
  "current_user",
  "default",
  "desc",
  "distinct",
  "do",
  "else",
  "end",
  "except",
  "false",
  "fetch",
  "for",
  "foreign",
  "from",
  "grant",
  "group",
  "having",
  "in",
  "initially",
  "intersect",
  "into",
  "leading",
  "limit",
  "localtime",
  "localtimestamp",
  "not",
  "null",
  "offset",
  "on",
  "only",
  "or",
  "order",
  "placing",
  "primary",
  "references",
  "returning",
  "select",
  "session_user",
  "some",
  "symmetric",
  "table",
  "then",
  "to",
  "trailing",
  "true",
  "union",
  "unique",
  "user",
  "using",
  "variadic",
  "when",
  "where",
  "window",
  "with",
]);

export function buildIndex(schema: CompletionSchema): SchemaIndex {
  const rank = (s: string) => {
    const at = schema.searchPath.indexOf(s);
    return at === -1 ? schema.searchPath.length : at;
  };
  const byName = new Map<string, Table[]>();
  for (const table of schema.tables) {
    const key = table.name.toLowerCase();
    const list = byName.get(key);
    if (list) list.push(table);
    else byName.set(key, [table]);
  }
  for (const list of byName.values()) list.sort((a, b) => rank(a.schema) - rank(b.schema));
  return {
    schema,
    byName,
    schemas: [...new Set(schema.tables.map((t) => t.schema))],
    inPath: new Set(schema.searchPath),
  };
}

/** The table a reference points at: in its schema if it has one, else the first on the search path. */
export function resolve(
  index: SchemaIndex,
  ref: Pick<TableRef, "schema" | "name">,
): Table | undefined {
  const list = index.byName.get(ref.name.toLowerCase());
  if (!list) return undefined;
  if (ref.schema !== null)
    return list.find((t) => t.schema.toLowerCase() === ref.schema?.toLowerCase());
  return list.find((t) => index.inPath.has(t.schema));
}

const columnsOf = (table: Table, owner: string): Suggestion[] =>
  table.columns.map((c) => ({
    label: c.name,
    insert: quoteIfNeeded(c.name),
    type: "column",
    detail: `${c.typeName} · ${owner}`,
    boost: 10,
  }));

const functionSuggestion = (name: string, signature: string, boost: number): Suggestion => ({
  label: name,
  insert: quoteIfNeeded(name),
  type: "function",
  detail: signature,
  boost,
  call: signature.startsWith("()") ? "none" : "args",
});

/** The offers for `context`, unfiltered: the editor narrows them as the word is typed. */
export function suggest(index: SchemaIndex, context: CompletionContext): Suggestion[] {
  switch (context.kind) {
    case "none":
      return [];

    case "member": {
      const [first, second] = context.qualifier;
      const out: Suggestion[] = [];
      if (context.qualifier.length === 1 && first !== undefined) {
        // `u.` where u is an alias or a table used in the statement.
        const used = context.scope.filter(
          (r) =>
            (r.alias ?? r.name).toLowerCase() === first.toLowerCase() ||
            r.name.toLowerCase() === first.toLowerCase(),
        );
        for (const ref of used) {
          const table = resolve(index, ref);
          if (table) out.push(...columnsOf(table, ref.alias ?? table.name));
        }
        if (out.length > 0) return dedupe(out);
        // `public.` : the tables of a schema.
        for (const table of index.schema.tables) {
          if (table.schema.toLowerCase() === first.toLowerCase())
            out.push(tableSuggestion(table, false));
        }
        if (out.length > 0) return out;
        // `users.` outside any FROM: the columns of that table.
        const table = resolve(index, { schema: null, name: first });
        return table ? columnsOf(table, table.name) : [];
      }
      if (context.qualifier.length === 2 && first !== undefined && second !== undefined) {
        const table = resolve(index, { schema: first, name: second });
        return table ? columnsOf(table, table.name) : [];
      }
      return [];
    }

    case "table": {
      const out: Suggestion[] = [];
      for (const table of index.schema.tables) {
        out.push(tableSuggestion(table, !index.inPath.has(table.schema)));
      }
      for (const schema of index.schemas) {
        out.push({
          label: schema,
          insert: quoteIfNeeded(schema),
          type: "schema",
          detail: "schema",
          boost: -2,
        });
      }
      return out;
    }

    case "expression": {
      const out: Suggestion[] = [];
      for (const ref of context.scope) {
        const table = resolve(index, ref);
        if (!table) continue;
        out.push(...columnsOf(table, ref.alias ?? table.name));
        // The name to qualify with (`u.`), for when two tables have the same column.
        const qualifier = ref.alias ?? table.name;
        out.push({
          label: qualifier,
          insert: quoteIfNeeded(qualifier),
          type: "alias",
          detail: ref.alias ? `alias of ${table.name}` : table.kind,
          boost: 4,
        });
      }
      for (const [name, signature] of BUILTIN_FUNCTIONS)
        out.push(functionSuggestion(name, signature, 0));
      for (const fn of index.schema.functions) {
        const shown = index.inPath.has(fn.schema) ? fn.name : `${fn.schema}.${fn.name}`;
        out.push({ ...functionSuggestion(fn.name, fn.signature, 5), label: shown });
      }
      return out;
    }
  }
}

function tableSuggestion(table: Table, qualified: boolean): Suggestion {
  const name = qualified
    ? `${quoteIfNeeded(table.schema)}.${quoteIfNeeded(table.name)}`
    : quoteIfNeeded(table.name);
  return {
    label: qualified ? `${table.schema}.${table.name}` : table.name,
    insert: name,
    type: table.kind === "view" || table.kind === "materializedView" ? "view" : "table",
    detail: qualified ? table.kind : `${table.schema} · ${table.kind}`,
    boost: 10,
  };
}

/** Drop later duplicates of the same column (the same table used twice). */
function dedupe(list: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.label) ? false : (seen.add(s.label), true)));
}
