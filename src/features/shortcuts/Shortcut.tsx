import { useShortcutLabel } from "@/features/shortcuts/labels";

/** The keys of a command as they are now (`⌘T`), for a tooltip or a hint; nothing if it has none. */
export function Shortcut({ id }: { id: string }) {
  return <>{useShortcutLabel(id)}</>;
}
