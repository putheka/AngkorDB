import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
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
import { sqlAutocomplete } from "@/features/query/completion/source";
import type { SchemaIndex } from "@/features/query/completion/suggest";
import { editorTheme, highlightStyle } from "@/features/query/editorTheme";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

export type RunMode = "current" | "all";

/** What the tab around the editor can ask of it. */
export interface SqlEditorHandle {
  focus: () => void;
  /** Move the cursor to `offset`, scroll to it and underline the word there. */
  showError: (offset: number) => void;
  /** Replace the selection (or insert at the cursor) with `text`, and focus the editor. */
  insertText: (text: string) => void;
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
  /** The schema to complete names from (ANG-30); `null` until it has loaded. */
  completion: SchemaIndex | null;
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
  completion,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The editor is created once; these always point at the latest props.
  const callbacks = useRef({ onTextChange, onSelectionChange, onRun, completion });
  useEffect(() => {
    callbacks.current = { onTextChange, onSelectionChange, onRun, completion };
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
    insertText: (text) => {
      const editor = view.current;
      if (!editor) return;
      const { from, to } = editor.state.selection.main;
      editor.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
        scrollIntoView: true,
        userEvent: "input.paste",
      });
      editor.focus();
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
        sqlAutocomplete(() => callbacks.current.completion),
        syntaxHighlighting(highlightStyle),
        errorMarks,
        editorTheme,
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
