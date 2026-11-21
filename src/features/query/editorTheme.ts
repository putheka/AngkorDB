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
    // Set per editor from the preferences (`--editor-font-size`, `--editor-font`).
    fontSize: "var(--editor-font-size, 13px)",
    backgroundColor: "var(--background)",
    color: "var(--foreground)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font, var(--font-mono))",
    lineHeight: "1.6",
    overflow: "auto",
  },
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
    backgroundColor: "color-mix(in oklab, var(--app-accent) 28%, transparent) !important",
  },
  "&.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in oklab, var(--app-accent) 38%, transparent) !important",
  },
  ".cm-matchingBracket": {
    backgroundColor: "color-mix(in oklab, var(--app-accent) 25%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--app-accent) 50%, transparent)",
  },
  // The mode line of vim mode (`-- INSERT --`, `:` commands).
  ".cm-vim-panel": {
    padding: "2px 12px",
    fontFamily: "var(--editor-font, var(--font-mono))",
    fontSize: "12px",
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-vim-panel input": { color: "var(--foreground)", fontFamily: "inherit" },
  ".cm-fat-cursor": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 70%, transparent) !important",
    color: "var(--background) !important",
  },
  "&:not(.cm-focused) .cm-fat-cursor": {
    background: "none !important",
    outline: "1px solid var(--foreground)",
    color: "inherit !important",
  },
  ".cm-sql-error": {
    textDecoration: "underline wavy var(--destructive)",
    textUnderlineOffset: "3px",
    backgroundColor: "color-mix(in oklab, var(--destructive) 15%, transparent)",
  },
});
