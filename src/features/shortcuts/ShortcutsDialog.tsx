import { RotateCcwIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { bindingsOf } from "@/features/shortcuts/bindings";
import { COMMANDS, GROUP_ORDER, type CommandDef } from "@/features/shortcuts/commands";
import { chordIdOf, displayChord } from "@/features/shortcuts/keys";
import { cn } from "@/lib/utils";
import { useShortcuts } from "@/stores/shortcuts";

/** Keys that belong to a field or a list, not to a command: shown for reference, not changeable. */
const FIXED_KEYS: { keys: string; what: string }[] = [
  { keys: "↩  ⎋", what: "Accept or cancel an edit, in a cell or a field" },
  { keys: "↑ ↓", what: "Move in lists, menus and the sidebar" },
  { keys: "Space", what: "Show or hide the details of the selected row" },
  { keys: "⌫", what: "Clear the selected cells (⌘⌫ sets NULL)" },
  { keys: "⌘↩", what: "Save a long text or JSON cell" },
  { keys: "⌘C ⌘V ⌘X ⌘Z", what: "Copy, paste, cut and undo (macOS)" },
];

type Pending =
  | { kind: "recording"; id: string }
  | { kind: "conflict"; id: string; chord: string; reason: string };

/**
 * Every shortcut, searchable. A key can be added to a command, taken away, or put back to the
 * default; a key another command already uses is refused unless the person replaces it.
 */
export function ShortcutsDialog() {
  const open = useShortcuts((s) => s.dialogOpen);
  const close = useShortcuts((s) => s.closeDialog);
  const overrides = useShortcuts((s) => s.overrides);
  const { assign, remove, reset, resetAll } = useShortcuts.getState();
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // While a key is being picked, the next key press is the answer: nothing else may see it
  // (the dialog would close on Esc, and a bound shortcut would run).
  const recording = pending?.kind === "recording" ? pending.id : null;
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setPending(null);
        return;
      }
      const chord = chordIdOf(e);
      if (!chord) return; // a modifier on its own: wait for the key
      const result = useShortcuts.getState().assign(recording, chord);
      if (result.ok) {
        setPending(null);
        setMessage(null);
      } else if (result.conflicts.length > 0 && !result.conflicts.some((c) => c.fixed)) {
        setPending({ kind: "conflict", id: recording, chord, reason: result.reason });
      } else {
        setPending(null);
        setMessage(result.reason);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const query = search.trim().toLowerCase();
  const groups = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        group,
        commands: COMMANDS.filter(
          (c) =>
            c.group === group &&
            !c.hidden &&
            (!query ||
              c.title.toLowerCase().includes(query) ||
              bindingsOf(c, overrides).some((chord) =>
                displayChord(chord).toLowerCase().includes(query),
              )),
        ),
      })).filter((g) => g.commands.length > 0),
    [query, overrides],
  );
  const changed = Object.keys(overrides).length > 0;

  function done() {
    setPending(null);
    setMessage(null);
    setSearch("");
    close();
  }

  const row = (def: CommandDef) => {
    const chords = bindingsOf(def, overrides);
    const isRecording = pending?.kind === "recording" && pending.id === def.id;
    const conflict = pending?.kind === "conflict" && pending.id === def.id ? pending : null;
    return (
      <li key={def.id} className="flex flex-col gap-1 py-1.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate">{def.title}</span>
          {def.scope !== "app" && def.group !== "General" && def.scope !== "editor" && (
            <span className="shrink-0 text-[11px] text-muted-foreground">in {def.scope}</span>
          )}
          <span className="flex shrink-0 items-center gap-1">
            {chords.length === 0 && !isRecording && (
              <span className="text-xs text-muted-foreground">no key</span>
            )}
            {chords.map((chord) => (
              <kbd
                key={chord}
                className="group inline-flex items-center gap-1 rounded border bg-muted px-1.5 py-0.5 font-sans text-xs"
              >
                {displayChord(chord)}
                {!def.fixed && (
                  <button
                    type="button"
                    aria-label={`Remove ${displayChord(chord)} from ${def.title}`}
                    className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => remove(def.id, chord)}
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </kbd>
            ))}
            {isRecording ? (
              <span className="rounded border border-dashed px-1.5 py-0.5 text-xs text-muted-foreground">
                Press the keys… (esc to cancel)
              </span>
            ) : def.fixed ? (
              <span className="text-[11px] text-muted-foreground">fixed by the menu bar</span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={`Add a key to ${def.title}`}
                onClick={() => {
                  setMessage(null);
                  setPending({ kind: "recording", id: def.id });
                }}
              >
                Add key
              </Button>
            )}
            {overrides[def.id] && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Reset ${def.title} to its default`}
                onClick={() => reset(def.id)}
              >
                <RotateCcwIcon />
              </Button>
            )}
          </span>
        </div>
        {conflict && (
          <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
            <span className="min-w-0 flex-1">
              {displayChord(conflict.chord)}: {conflict.reason}
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => {
                assign(def.id, conflict.chord, true);
                setPending(null);
              }}
            >
              Use it here
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && done()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Add or take away keys for a command. A key another command uses asks first.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search commands or keys"
          aria-label="Search shortcuts"
          autoComplete="off"
        />
        {message && (
          <p role="alert" className="text-xs text-destructive">
            {message}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {groups.map(({ group, commands }) => (
            <section key={group}>
              <h3 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group}
              </h3>
              <ul className={cn("divide-y")}>{commands.map(row)}</ul>
            </section>
          ))}
          {groups.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">Nothing matches.</p>
          )}
          {!query && (
            <section>
              <h3 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Fixed keys
              </h3>
              <ul className="divide-y">
                {FIXED_KEYS.map((fixed) => (
                  <li key={fixed.what} className="flex items-center gap-2 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">{fixed.what}</span>
                    <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs">
                      {fixed.keys}
                    </kbd>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={!changed} onClick={resetAll}>
            Reset all to default
          </Button>
          <Button type="button" onClick={done}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
