import { HighlightStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

/** Colors come from CSS variables in `globals.css`, so light and dark need no second style. */
export const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--sql-keyword)", fontWeight: "500" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--sql-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--sql-number)" },
  { tag: [tags.typeName, tags.standard(tags.name), tags.propertyName], color: "var(--sql-type)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--sql-comment)", fontStyle: "italic" },
]);

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "13px",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { caretColor: "var(--foreground)", padding: "8px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--muted-foreground)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "36px" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 45%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, rgb(59 130 246) 28%, transparent) !important",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, rgb(59 130 246) 38%, transparent) !important",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, rgb(59 130 246) 25%, transparent)",
    outline: "1px solid color-mix(in oklab, rgb(59 130 246) 50%, transparent)",
  },
  ".cm-sql-error": {
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
    backgroundColor: "color-mix(in oklab, var(--destructive) 15%, transparent)",
  },
});
