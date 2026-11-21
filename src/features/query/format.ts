/**
 * Formatting SQL (ANG-34) with `sql-formatter`, plus a guarantee it can't change what a function
 * does: every `$$ … $$` / `$tag$ … $tag$` body must come out exactly as it went in, or nothing
 * is changed at all.
 *
 * No alias imports: this runs under plain Node in the unit tests.
 */
import { format } from "sql-formatter";

export type KeywordCase = "upper" | "lower" | "preserve";

export interface FormatOptions {
  keywordCase: KeywordCase;
  tabWidth: number;
}

/** The text could not be formatted; `message` says why, in words for the person. */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_\u0080-￿]/;

/**
 * The dollar-quoted literals in `sql`, tags included, in order. Knows enough of the syntax not
 * to see one inside a string, a quoted name or a comment, and that `$1` is a parameter.
 */
export function dollarQuoted(sql: string): string[] {
  const found: string[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql.charAt(i);
    const next = sql.charAt(i + 1);
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && next === "*") {
      // Block comments nest in PostgreSQL.
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
    } else if (c === "'" || c === '"') {
      // `E'…'` strings also escape with a backslash.
      const escapes =
        c === "'" && /[eE]/.test(sql.charAt(i - 1)) && !IDENT_PART.test(sql.charAt(i - 2));
      i++;
      while (i < n) {
        const d = sql.charAt(i);
        if (escapes && d === "\\") i += 2;
        else if (d === c) {
          if (sql.charAt(i + 1) === c) i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
    } else if (c === "$" && !IDENT_PART.test(sql.charAt(i - 1))) {
      // `$tag$`: a tag is a name (no digits first) or nothing at all.
      let j = i + 1;
      if (IDENT_START.test(sql.charAt(j))) while (IDENT_PART.test(sql.charAt(j))) j++;
      if (sql.charAt(j) === "$") {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        if (end === -1) {
          // Never closed: the rest of the text is the literal, and it is not touched either.
          found.push(sql.slice(i));
          i = n;
        } else {
          found.push(sql.slice(i, end + tag.length));
          i = end + tag.length;
        }
      } else i++;
    } else i++;
  }
  return found;
}

/** The text re-laid out. Throws a {@link FormatError} if it can't be done safely. */
export function formatSql(sql: string, options: FormatOptions): string {
  if (!sql.trim()) return sql;
  const bodies = dollarQuoted(sql);

  let formatted: string;
  try {
    formatted = format(sql, {
      language: "postgresql",
      keywordCase: options.keywordCase,
      tabWidth: options.tabWidth,
      linesBetweenQueries: 1,
    });
  } catch (error) {
    const first = (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
    throw new FormatError(`Could not format this SQL: ${first}`);
  }

  // Every body must still be in the output, untouched and in the same order.
  let from = 0;
  for (const body of bodies) {
    const at = formatted.indexOf(body, from);
    if (at === -1) {
      throw new FormatError(
        "Formatting would have changed the text inside a $$ … $$ body, so nothing was changed.",
      );
    }
    from = at + body.length;
  }

  // Keep a final line break if the text had one.
  const tail = /\n+$/.exec(sql);
  return tail ? `${formatted}\n` : formatted;
}
