import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, keymap, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { editorTheme, highlightStyle } from "@/features/query/editorTheme";

interface JsonRawProps {
  text: string;
  onChange: (text: string) => void;
  readOnly: boolean;
}

/** CodeMirror with JSON highlighting. The text lives here while typing; `text` changes from outside replace it. */
export function JsonRaw({ text, onChange, readOnly }: JsonRawProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          drawSelection(),
          history(),
          bracketMatching(),
          json(),
          syntaxHighlighting(highlightStyle),
          editorTheme,
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Created once; later text comes in through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // Text that changed from outside (Format, Minify, a tree edit, Revert).
  useEffect(() => {
    const editor = view.current;
    if (!editor || editor.state.doc.toString() === text) return;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  }, [text]);

  return <div ref={host} className="h-full min-h-0" />;
}
