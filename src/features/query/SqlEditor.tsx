import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { HighlightStyle, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type RunMode = "current" | "all";

/** What the tab around the editor can ask of it. */
export interface SqlEditorHandle {
  focus: () => void;
  /** Move the cursor to `offset`, scroll to it and underline the word there. */
  showError: (offset: number) => void;
  /** The text as it is now, and where the cursor or selection is. */
  snapshot: () => { text: string; from: number; to: number };
}

interface SqlEditorProps {
  ref?: Ref<SqlEditorHandle>;
  initialText: string;
  initialSelection: { anchor: number; head: number };
  onTextChange: (text: string) => void;
  onSelectionChange: (selection: { anchor: number; head: number }) => void;
  /** ⌘↵ runs the selection or the statement at the cursor; ⌘⇧↵ runs everything. */
  onRun: (mode: RunMode) => void;
}

const setErrorMark = StateEffect.define<{ from: number; to: number } | null>();

/** The underlined spot of the last error. Typing anywhere removes it: the text it points at moved. */
const errorMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setErrorMark)) {
        const range = effect.value;
        return range === null
          ? Decoration.none
          : Decoration.set([
              Decoration.mark({ class: "cm-sql-error" }).range(range.from, range.to),
            ] satisfies Range<Decoration>[]);
      }
    }
    return transaction.docChanged ? Decoration.none : marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Colors come from CSS variables in `globals.css`, so light and dark need no second style. */
const highlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: "var(--sql-keyword)", fontWeight: "500" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--sql-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--sql-number)" },
  { tag: [tags.typeName, tags.standard(tags.name)], color: "var(--sql-type)" },
  { tag: [tags.lineComment, tags.blockComment], color: "var(--sql-comment)", fontStyle: "italic" },
]);

const theme = EditorView.theme({
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

/**
 * CodeMirror 6 with the PostgreSQL dialect. The document lives in the editor while it is open;
 * the parent hears about changes and keeps the text, so it survives the editor being unmounted
 * when another tab comes to the front.
 */
export function SqlEditor({
  ref,
  initialText,
  initialSelection,
  onTextChange,
  onSelectionChange,
  onRun,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The editor is created once; these always point at the latest props.
  const callbacks = useRef({ onTextChange, onSelectionChange, onRun });
  useEffect(() => {
    callbacks.current = { onTextChange, onSelectionChange, onRun };
  });

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    showError: (offset) => {
      const editor = view.current;
      if (!editor) return;
      const at = Math.min(Math.max(offset, 0), editor.state.doc.length);
      const word = editor.state.wordAt(at);
      const from = word ? word.from : at;
      const to = word ? word.to : Math.min(at + 1, editor.state.doc.length);
      editor.dispatch({
        selection: { anchor: from },
        effects: [setErrorMark.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })],
      });
    },
    snapshot: () => {
      const editor = view.current;
      const main = editor?.state.selection.main;
      return { text: editor?.state.doc.toString() ?? "", from: main?.from ?? 0, to: main?.to ?? 0 };
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const runKey = (mode: RunMode) => () => {
      callbacks.current.onRun(mode);
      return true;
    };
    const length = initialText.length;
    const state = EditorState.create({
      doc: initialText,
      selection: {
        anchor: Math.min(initialSelection.anchor, length),
        head: Math.min(initialSelection.head, length),
      },
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        bracketMatching(),
        sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
        syntaxHighlighting(highlightStyle),
        errorMarks,
        theme,
        keymap.of([
          { key: "Mod-Enter", run: runKey("current"), preventDefault: true },
          { key: "Mod-Shift-Enter", run: runKey("all"), preventDefault: true },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onTextChange(update.state.doc.toString());
          if (update.selectionSet || update.docChanged) {
            const { anchor, head } = update.state.selection.main;
            callbacks.current.onSelectionChange({ anchor, head });
          }
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Created once per mount. The text and selection it starts with are the saved ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={host} className="h-full min-h-0" />;
}
