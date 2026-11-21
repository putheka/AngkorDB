/**
 * The one place a key press turns into a command (ANG-52). A screen that does the work calls
 * `useShortcut(id, handler)` while it is open; the window's single `keydown` listener finds the
 * commands the pressed keys are bound to (defaults, or what the person chose) and runs the
 * handler of the first one that is open. Nothing else in the app listens for ⌘-keys.
 */
import { useEffect, useRef } from "react";

import { commandsByChord } from "@/features/shortcuts/bindings";
import { COMMANDS } from "@/features/shortcuts/commands";
import { chordIdOf } from "@/features/shortcuts/keys";
import { useShortcuts } from "@/stores/shortcuts";

/** `false` means "not mine": the next command that wants these keys gets a turn. */
export type ShortcutHandler = (event: KeyboardEvent | null) => unknown;

interface Entry {
  id: string;
  run: ShortcutHandler;
  priority: number;
  seq: number;
}

const entries = new Set<Entry>();
let counter = 0;

function register(id: string, run: ShortcutHandler, priority: number): () => void {
  const entry: Entry = { id, run, priority, seq: ++counter };
  entries.add(entry);
  return () => void entries.delete(entry);
}

/** Open handlers, the one that wins first: higher priority, then the one opened last. */
const byTurn = (a: Entry, b: Entry) => b.priority - a.priority || b.seq - a.seq;

/** Is the command available right now (its screen is open)? */
export const isAvailable = (id: string): boolean => [...entries].some((e) => e.id === id);

/** Run a command without a key press (the command palette). `false` when it isn't available. */
export function runCommand(id: string): boolean {
  for (const entry of [...entries].filter((e) => e.id === id).sort(byTurn)) {
    if (entry.run(null) !== false) return true;
  }
  return false;
}

/**
 * Handle a key press: run the command bound to it. Returns whether one did (the key press is
 * then stopped, as ⌘S must not also reach the browser).
 */
export function dispatchKey(event: KeyboardEvent): boolean {
  // Someone closer to the focus (the SQL editor, a cell editor) already took this key.
  if (event.defaultPrevented || event.isComposing) return false;
  const chord = chordIdOf(event);
  if (!chord) return false;
  const wanted = commandsByChord(COMMANDS, useShortcuts.getState().overrides).get(chord);
  if (!wanted) return false;
  const ids = new Set(wanted.map((c) => c.id));
  for (const entry of [...entries].filter((e) => ids.has(e.id)).sort(byTurn)) {
    if (entry.run(event) !== false) {
      event.preventDefault();
      return true;
    }
  }
  return false;
}

/** Listen for keys, once, for the whole window. */
export function useShortcutDispatcher() {
  useEffect(() => {
    window.addEventListener("keydown", dispatchKey);
    return () => window.removeEventListener("keydown", dispatchKey);
  }, []);
}

/**
 * Make a command available while the calling screen is open (and `enabled`). `priority`
 * settles a key two open commands share: the one whose `handler` returns `false` passes it on.
 */
export function useShortcut(
  id: string,
  handler: ShortcutHandler,
  options: { enabled?: boolean; priority?: number } = {},
) {
  const { enabled = true, priority = 0 } = options;
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return register(id, (event) => latest.current(event), priority);
  }, [id, enabled, priority]);
}
