import { bindingsOf } from "@/features/shortcuts/bindings";
import { COMMANDS, commandById } from "@/features/shortcuts/commands";
import { displayChord } from "@/features/shortcuts/keys";
import { useShortcuts } from "@/stores/shortcuts";

/** The keys of a command as a Mac shows them (`⇧⌘P`); the first one when it has several. */
export function shortcutLabel(id: string, overrides = useShortcuts.getState().overrides): string {
  const def = commandById(id);
  const first = def ? bindingsOf(def, overrides)[0] : undefined;
  return first ? displayChord(first) : "";
}

/** [`shortcutLabel`] that follows the person's changes while the component is shown. */
export function useShortcutLabel(id: string): string {
  const overrides = useShortcuts((s) => s.overrides);
  return shortcutLabel(id, overrides);
}

export { COMMANDS };
