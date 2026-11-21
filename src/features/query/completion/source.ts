import { autocompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, keywordCompletionSource } from "@codemirror/lang-sql";
import type { Extension } from "@codemirror/state";

import { analyze } from "@/features/query/completion/analyze";
import { suggest, type SchemaIndex, type Suggestion } from "@/features/query/completion/suggest";

function toCompletion(s: Suggestion): Completion {
  const completion: Completion = {
    label: s.label,
    type: s.type === "alias" ? "namespace" : s.type === "schema" ? "namespace" : s.type,
    apply: s.insert,
    ...(s.detail !== undefined ? { detail: s.detail } : {}),
    ...(s.boost !== undefined ? { boost: s.boost } : {}),
  };
  if (s.call) {
    // A function: write the call and put the cursor inside the parentheses.
    completion.apply = (view, _completion, from, to) => {
      const text = `${s.insert}()`;
      const caret = from + s.insert.length + (s.call === "none" ? 2 : 1);
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: caret },
        userEvent: "input.complete",
      });
    };
  }
  return completion;
}

/** Names from the schema: tables after FROM, columns after `alias.`, columns and functions elsewhere. */
export function schemaSource(getIndex: () => SchemaIndex | null): CompletionSource {
  return (context) => {
    const index = getIndex();
    if (!index) return null;
    const found = analyze(context.state.doc.toString(), context.pos);
    if (found.kind === "none") return null;
    // Typing opens the list once there is a word, or right after a dot; Ctrl-Space opens it anywhere.
    if (!context.explicit && found.prefix === "" && found.kind !== "member") return null;
    const options = suggest(index, found).map(toCompletion);
    return options.length === 0 ? null : { from: found.from, options, validFor: /^["\w$]*$/ };
  };
}

/** The editor extension: our schema-aware source plus the PostgreSQL keywords. */
export function sqlAutocomplete(getIndex: () => SchemaIndex | null): Extension {
  return autocompletion({
    override: [schemaSource(getIndex), keywordCompletionSource(PostgreSQL, false)],
    activateOnTyping: true,
    maxRenderedOptions: 60,
  });
}
