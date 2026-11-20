import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { classHighlighter, highlightCode } from "@lezer/highlight";
import { useMemo, type ReactNode } from "react";

const parser = sql({ dialect: PostgreSQL }).language.parser;

/** Read-only, syntax-colored SQL (colors in `globals.css`, `.sql-text`). */
export function SqlText({ code }: { code: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    highlightCode(
      code,
      parser.parse(code),
      classHighlighter,
      (text, classes) =>
        out.push(
          classes ? (
            <span key={out.length} className={classes}>
              {text}
            </span>
          ) : (
            text
          ),
        ),
      () => out.push("\n"),
    );
    return out;
  }, [code]);
  return <code className="sql-text font-mono">{nodes}</code>;
}
