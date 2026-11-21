import {
  copyLineDown,
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from "@codemirror/commands";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { selectNextOccurrence } from "@codemirror/search";
import {
  Compartment,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  crosshairCursor,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type KeyBinding,
  rectangularSelection,
  type DecorationSet,
} from "@codemirror/view";
import { vim } from "@replit/codemirror-vim";
import { sqlAutocomplete } from "@/features/query/completion/source";
import type { SchemaIndex } from "@/features/query/completion/suggest";
import { editorTheme, highlightStyle } from "@/features/query/editorTheme";
import { FormatError, formatSql } from "@/features/query/format";
import { FONT_CHOICES } from "@/features/query/prefs";
import { bindingsOf } from "@/features/shortcuts/bindings";
import { COMMANDS } from "@/features/shortcuts/commands";
import { toCodeMirrorKey } from "@/features/shortcuts/keys";
import { useShortcuts } from "@/stores/shortcuts";
import { useEditorPrefs } from "@/stores/editorPrefs";
import { useEffect, useImperativeHandle, useRef, type CSSProperties, type Ref } from "react";

export type RunMode = "current" | "all";

/**
 * The editor's own commands on the keys the registry says (`commands.ts`), above everything
 * else, vim included.
 */
function appKeymap(
  runKey: (mode: RunMode) => () => boolean,
  formatRef: { current: () => void },
): Extension {
  const handlers: Record<string, (view: EditorView) => boolean> = {
    "editor.run": runKey("current"),
    "editor.runAll": runKey("all"),
    "editor.format": () => {
      formatRef.current();
      return true;
    },
    "editor.comment": toggleComment,
    "editor.duplicateLine": copyLineDown,
    "editor.selectNext": selectNextOccurrence,
  };
  const { overrides } = useShortcuts.getState();
  const bindings: KeyBinding[] = [];
  for (const def of COMMANDS) {
    const run = handlers[def.id];
    if (!run) continue;
    for (const chord of bindingsOf(def, overrides)) {
      const key = toCodeMirrorKey(chord);
      if (key) bindings.push({ key, run, preventDefault: true });
    }
  }
  return Prec.highest(keymap.of(bindings));
}

/** What the tab around the editor can ask of it. */
export interface SqlEditorHandle {
  focus: () => void;
  /** Move the cursor to `offset`, scroll to it and underline the word there. */
  showError: (offset: number) => void;
  /** Replace the selection (or insert at the cursor) with `text`, and focus the editor. */
  insertText: (text: string) => void;
  /** Lay out the selection, or everything when nothing is selected. */
  format: () => void;
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
  /** The text could not be formatted; this says why. */
  onFormatError?: (message: string) => void;
}

/** Vim keys on or off. High precedence: vim has to see keys before the other bindings. */
const vimExtension = (on: boolean): Extension => (on ? Prec.high(vim({ status: true })) : []);
const numbersExtension = (on: boolean): Extension => (on ? lineNumbers() : []);
const wrapExtension = (on: boolean): Extension => (on ? EditorView.lineWrapping : []);
const tabExtension = (size: number): Extension => [
  EditorState.tabSize.of(size),
  indentUnit.of(" ".repeat(size)),
];

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
  onFormatError,
}: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The editor is created once; these always point at the latest props.
  const callbacks = useRef({ onTextChange, onSelectionChange, onRun, completion, onFormatError });
  useEffect(() => {
    callbacks.current = { onTextChange, onSelectionChange, onRun, completion, onFormatError };
  });

  // The preferences (ANG-34). The parts CodeMirror owns are swapped in place, without recreating
  // the editor (that would lose the undo history); the font goes through CSS variables.
  const prefs = useEditorPrefs();
  const latestPrefs = useRef(prefs);
  useEffect(() => {
    latestPrefs.current = prefs;
  });
  const parts = useRef({
    vim: new Compartment(),
    numbers: new Compartment(),
    wrap: new Compartment(),
    tabs: new Compartment(),
    shortcuts: new Compartment(),
  });

  /** Format the selection, or all of the text; the cursor stays about where it was. */
  const formatText = () => {
    const editor = view.current;
    if (!editor) return;
    const { from, to } = editor.state.selection.main;
    const whole = from === to;
    const start = whole ? 0 : from;
    const end = whole ? editor.state.doc.length : to;
    const before = editor.state.sliceDoc(start, end);
    try {
      const after = formatSql(before, {
        keywordCase: latestPrefs.current.keywordCase,
        tabWidth: latestPrefs.current.tabSize,
      });
      if (after === before) return;
      editor.dispatch({
        changes: { from: start, to: end, insert: after },
        selection: whole
          ? { anchor: Math.min(from, after.length) }
          : { anchor: start, head: start + after.length },
        scrollIntoView: true,
        userEvent: "input.format",
      });
    } catch (error) {
      const message = error instanceof FormatError ? error.message : "Could not format this SQL.";
      callbacks.current.onFormatError?.(message);
    }
  };
  const formatRef = useRef(formatText);
  useEffect(() => {
    formatRef.current = formatText;
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
    format: () => formatRef.current(),
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
        parts.current.vim.of(vimExtension(latestPrefs.current.vim)),
        parts.current.numbers.of(numbersExtension(latestPrefs.current.lineNumbers)),
        parts.current.wrap.of(wrapExtension(latestPrefs.current.wordWrap)),
        parts.current.tabs.of(tabExtension(latestPrefs.current.tabSize)),
        // Several cursors: ⌘-click adds one, ⌥-drag makes a column, ⌘D picks the next match.
        EditorState.allowMultipleSelections.of(true),
        rectangularSelection(),
        crosshairCursor(),
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
        // The app's own shortcuts come before vim, which would swallow ⌘-keys in normal mode.
        // Their keys are the registry's, so changing one applies to the open editors too.
        parts.current.shortcuts.of(appKeymap(runKey, formatRef)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
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

  // Shortcuts the person changes while the editor is open.
  const overrides = useShortcuts((s) => s.overrides);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const runKey = (mode: RunMode) => () => {
      callbacks.current.onRun(mode);
      return true;
    };
    editor.dispatch({
      effects: parts.current.shortcuts.reconfigure(appKeymap(runKey, formatRef)),
    });
  }, [overrides]);

  // Preferences that change while the editor is open.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({
      effects: [
        parts.current.vim.reconfigure(vimExtension(prefs.vim)),
        parts.current.numbers.reconfigure(numbersExtension(prefs.lineNumbers)),
        parts.current.wrap.reconfigure(wrapExtension(prefs.wordWrap)),
        parts.current.tabs.reconfigure(tabExtension(prefs.tabSize)),
      ],
    });
  }, [prefs.vim, prefs.lineNumbers, prefs.wordWrap, prefs.tabSize]);
  useEffect(() => {
    view.current?.requestMeasure();
  }, [prefs.fontFamily, prefs.fontSize]);

  const fonts = {
    "--editor-font": FONT_CHOICES[prefs.fontFamily].css,
    "--editor-font-size": `${prefs.fontSize}px`,
  } as CSSProperties;
  return <div ref={host} style={fonts} className="h-full min-h-0" />;
}
