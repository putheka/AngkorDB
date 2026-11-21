/**
 * Where is the cursor in a SQL statement, and which tables does the statement use? (ANG-30)
 *
 * Not a SQL parser: it looks at the words around the cursor, which is what completion needs and
 * works on half-typed text. Pure functions with no imports, so they run under Node tests.
 */

export interface TableRef {
  /** `null` when the name was written without a schema. */
  schema: string | null;
  name: string;
  alias: string | null;
}

export type CompletionContext =
  /** After `alias.` or `schema.table.`: the names that live inside the qualifier. */
  | { kind: "member"; from: number; prefix: string; qualifier: string[]; scope: TableRef[] }
  /** Where a table is expected: after FROM, JOIN, INTO, UPDATE. */
  | { kind: "table"; from: number; prefix: string; scope: TableRef[] }
  /** Anywhere else in a statement: columns, functions, keywords. */
  | { kind: "expression"; from: number; prefix: string; scope: TableRef[] }
  | { kind: "none" };

interface Token {
  type: "word" | "quoted" | "dot" | "comma" | "open" | "close" | "semi" | "other";
  /** A word lower-cased, a quoted name without its quotes and doubled quotes. */
  value: string;
  start: number;
  end: number;
}

/** Words, quoted names and punctuation. Comments and strings are skipped (they can't be names). */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql.charAt(i);
    if (/\s/.test(c)) {
      i++;
    } else if (c === "-" && sql.charAt(i + 1) === "-") {
      while (i < n && sql.charAt(i) !== "\n") i++;
    } else if (c === "/" && sql.charAt(i + 1) === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (sql.charAt(i) === "'") {
          if (sql.charAt(i + 1) === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
    } else if (c === '"') {
      const start = i;
      i++;
      let value = "";
      while (i < n) {
        if (sql.charAt(i) === '"') {
          if (sql.charAt(i + 1) === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else value += sql.charAt(i++);
      }
      tokens.push({ type: "quoted", value, start, end: i });
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 40))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 40))?.[0] ?? "$$";
      const close = sql.indexOf(tag, i + tag.length);
      i = close < 0 ? n : close + tag.length;
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql.charAt(i))) i++;
      tokens.push({ type: "word", value: sql.slice(start, i).toLowerCase(), start, end: i });
    } else {
      const type =
        c === "."
          ? "dot"
          : c === ","
            ? "comma"
            : c === "("
              ? "open"
              : c === ")"
                ? "close"
                : c === ";"
                  ? "semi"
                  : "other";
      tokens.push({ type, value: c, start: i, end: i + 1 });
      i++;
    }
  }
  return tokens;
}

/** Words that can follow a table name without being its alias. */
const NOT_AN_ALIAS = new Set([
  "where",
  "on",
  "join",
  "inner",
  "left",
  "right",
  "full",
  "cross",
  "natural",
  "outer",
  "using",
  "group",
  "order",
  "limit",
  "offset",
  "having",
  "union",
  "intersect",
  "except",
  "returning",
  "set",
  "values",
  "select",
  "window",
  "for",
  "lateral",
  "fetch",
  "from",
  "into",
  "as",
  "and",
  "or",
  "not",
  "with",
  "default",
  "tablesample",
  "only",
]);

/** Keywords after which a table name is expected. */
const TABLE_KEYWORDS = new Set(["from", "join", "into", "update", "table", "only", "using"]);

const isName = (t: Token | undefined): t is Token => t?.type === "word" || t?.type === "quoted";

/** The tables a statement reads or writes, with the aliases it gives them. */
export function tablesIn(tokens: readonly Token[]): TableRef[] {
  const refs: TableRef[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const keyword = tokens[k];
    if (
      keyword?.type !== "word" ||
      !["from", "join", "update", "into", "using"].includes(keyword.value)
    ) {
      continue;
    }
    // `DELETE FROM`, `INSERT INTO`, `FROM a, b, c`: names separated by commas (only after FROM / USING).
    let at = k + 1;
    for (;;) {
      if (tokens[at]?.type === "word" && tokens[at]?.value === "only") at++;
      const first = tokens[at];
      if (!isName(first) || (first.type === "word" && NOT_AN_ALIAS.has(first.value))) break;
      let schema: string | null = null;
      let name = first.value;
      at++;
      if (tokens[at]?.type === "dot" && isName(tokens[at + 1])) {
        schema = name;
        name = tokens[at + 1]?.value ?? name;
        at += 2;
      }
      let alias: string | null = null;
      if (tokens[at]?.type === "word" && tokens[at]?.value === "as" && isName(tokens[at + 1])) {
        alias = tokens[at + 1]?.value ?? null;
        at += 2;
      } else if (
        isName(tokens[at]) &&
        !(tokens[at]?.type === "word" && NOT_AN_ALIAS.has(tokens[at]?.value ?? ""))
      ) {
        alias = tokens[at]?.value ?? null;
        at++;
      }
      refs.push({ schema, name, alias });
      const listy = keyword.value === "from" || keyword.value === "using";
      if (listy && tokens[at]?.type === "comma") at++;
      else break;
    }
  }
  return refs;
}

/** The tokens of the statement the cursor is in (between the `;` before and the one after). */
function statementAround(all: readonly Token[], cursor: number): Token[] {
  let start = 0;
  let end = all.length;
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t?.type !== "semi") continue;
    if (t.end <= cursor) start = i + 1;
    else {
      end = i;
      break;
    }
  }
  return all.slice(start, end);
}

/** What the cursor is doing in `sql`, for choosing what to suggest. */
export function analyze(sql: string, cursor: number): CompletionContext {
  const all = tokenize(sql);

  // Inside a string or a comment nothing is completed.
  const before = sql.slice(0, cursor);
  if (insideStringOrComment(before)) return { kind: "none" };

  const statement = statementAround(all, cursor);
  const scope = tablesIn(statement);

  // The word being typed: a name token the cursor is in or right after.
  let index = statement.findIndex((t) => t.start < cursor && cursor <= t.end && isName(t));
  let from = cursor;
  let prefix = "";
  const current = index >= 0 ? statement[index] : undefined;
  if (current) {
    from = current.start;
    prefix = sql.slice(current.start, cursor);
  } else {
    // Between tokens: the new word would go before the first token that starts after the cursor.
    index = statement.findIndex((t) => t.start >= cursor);
    if (index < 0) index = statement.length;
  }

  const prev = statement[index - 1];
  if (prev?.type === "dot") {
    const qualifier: string[] = [];
    let at = index - 1;
    while (statement[at]?.type === "dot" && isName(statement[at - 1])) {
      qualifier.unshift(statement[at - 1]?.value ?? "");
      at -= 2;
    }
    return { kind: "member", from, prefix, qualifier, scope };
  }

  if (prev?.type === "word" && TABLE_KEYWORDS.has(prev.value)) {
    return { kind: "table", from, prefix, scope };
  }
  if (prev?.type === "comma" && listKeyword(statement, index - 1) === "from") {
    return { kind: "table", from, prefix, scope };
  }
  return { kind: "expression", from, prefix, scope };
}

/** The clause keyword a comma belongs to: `FROM a, b` → "from", `SELECT a, b` → "select". */
function listKeyword(statement: readonly Token[], at: number): string | null {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const t = statement[i];
    if (!t) continue;
    if (t.type === "close") depth++;
    else if (t.type === "open") {
      if (depth === 0) return null;
      depth--;
    } else if (t.type === "word" && depth === 0) {
      if (
        [
          "from",
          "select",
          "where",
          "group",
          "order",
          "having",
          "set",
          "values",
          "on",
          "returning",
          "using",
        ].includes(t.value)
      ) {
        return t.value;
      }
    }
  }
  return null;
}

/** Is the end of `text` inside an open string, quoted name or comment? */
function insideStringOrComment(text: string): boolean {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (c === "-" && text.charAt(i + 1) === "-") {
      const eol = text.indexOf("\n", i);
      if (eol < 0) return true;
      i = eol + 1;
    } else if (c === "/" && text.charAt(i + 1) === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) return true;
    } else if (c === "'") {
      i++;
      let closed = false;
      while (i < n) {
        if (text.charAt(i) === "'") {
          if (text.charAt(i + 1) === "'") i += 2;
          else {
            i++;
            closed = true;
            break;
          }
        } else i++;
      }
      if (!closed) return true;
    } else if (c === '"') {
      // A quoted name being typed is still a name: completion works inside it.
      i++;
      while (i < n && text.charAt(i) !== '"') i++;
      i++;
    } else if (c === "$" && /^\$[A-Za-z_]*\$/.test(text.slice(i, i + 40))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i, i + 40))?.[0] ?? "$$";
      const close = text.indexOf(tag, i + tag.length);
      if (close < 0) return true;
      i = close + tag.length;
    } else i++;
  }
  return false;
}
