/**
 * Which keys run which command (ANG-52): the defaults, the changes the person made, conflicts
 * between two commands that want the same keys. Pure; no alias imports (unit-tested in Node).
 */
import { type CommandDef, type Scope } from "./commands.ts";
import { normalizeChord, whyNotAllowed } from "./keys.ts";

/** Per command, the chords the person chose in place of the defaults (empty: unbound). */
export type Overrides = Record<string, string[]>;

/** The chords of a command: the person's, or the defaults. */
export function bindingsOf(def: CommandDef, overrides: Overrides): readonly string[] {
  if (def.fixed) return def.keys;
  return overrides[def.id] ?? def.keys;
}

/** Two commands can be wanted by the same key press only when their scopes overlap. */
export function scopesOverlap(a: Scope, b: Scope): boolean {
  return a === b || a === "app" || b === "app";
}

/** The other commands that already use `chord` somewhere that would collide with `id`'s scope. */
export function findConflicts(
  commands: readonly CommandDef[],
  overrides: Overrides,
  id: string,
  chord: string,
): CommandDef[] {
  const mine = commands.find((c) => c.id === id);
  if (!mine) return [];
  return commands.filter(
    (other) =>
      other.id !== id &&
      scopesOverlap(mine.scope, other.scope) &&
      bindingsOf(other, overrides).includes(chord),
  );
}

/** Drop overrides that say what the defaults already say. */
function compact(commands: readonly CommandDef[], overrides: Overrides): Overrides {
  const result: Overrides = {};
  for (const [id, chords] of Object.entries(overrides)) {
    const def = commands.find((c) => c.id === id);
    if (!def || def.fixed) continue;
    const same = chords.length === def.keys.length && chords.every((c, i) => c === def.keys[i]);
    if (!same) result[id] = chords;
  }
  return result;
}

export type AssignResult =
  | { ok: true; overrides: Overrides; displaced: CommandDef[] }
  | { ok: false; reason: string; conflicts: CommandDef[] };

/**
 * Give `chord` to a command, besides what it already has. A conflicting command is refused
 * unless `replace` takes the chord away from it; a fixed one never gives it up.
 */
export function assignChord(
  commands: readonly CommandDef[],
  overrides: Overrides,
  id: string,
  chordText: string,
  replace = false,
): AssignResult {
  const def = commands.find((c) => c.id === id);
  if (!def) return { ok: false, reason: "There is no such command.", conflicts: [] };
  if (def.fixed) {
    return { ok: false, reason: "The menu bar owns this key; it can't change.", conflicts: [] };
  }
  const chord = normalizeChord(chordText);
  if (!chord) return { ok: false, reason: "That is not a key combination.", conflicts: [] };
  const forbidden = whyNotAllowed(chord);
  if (forbidden) return { ok: false, reason: forbidden, conflicts: [] };

  const conflicts = findConflicts(commands, overrides, id, chord);
  const fixed = conflicts.find((c) => c.fixed);
  if (fixed) {
    return { ok: false, reason: `${fixed.title} uses it, and that can't change.`, conflicts };
  }
  if (conflicts.length > 0 && !replace) {
    return {
      ok: false,
      reason: `Already used by ${conflicts.map((c) => c.title).join(", ")}.`,
      conflicts,
    };
  }

  const next: Overrides = { ...overrides };
  for (const other of conflicts) {
    next[other.id] = bindingsOf(other, overrides).filter((c) => c !== chord);
  }
  const mine = bindingsOf(def, overrides);
  if (!mine.includes(chord)) next[id] = [...mine, chord];
  return { ok: true, overrides: compact(commands, next), displaced: conflicts };
}

/** Take one chord away from a command (it may end up with none). */
export function removeChord(
  commands: readonly CommandDef[],
  overrides: Overrides,
  id: string,
  chord: string,
): Overrides {
  const def = commands.find((c) => c.id === id);
  if (!def || def.fixed) return overrides;
  return compact(commands, {
    ...overrides,
    [id]: bindingsOf(def, overrides).filter((c) => c !== chord),
  });
}

/** Back to the default keys of one command. */
export function resetCommand(overrides: Overrides, id: string): Overrides {
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== id));
}

/** What is stored, reduced to changes that make sense: known commands, real chords, no repeats. */
export function sanitizeOverrides(commands: readonly CommandDef[], value: unknown): Overrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Overrides = {};
  for (const [id, chords] of Object.entries(value)) {
    const def = commands.find((c) => c.id === id);
    if (!def || def.fixed || !Array.isArray(chords)) continue;
    const clean: string[] = [];
    for (const chord of chords) {
      const normal = typeof chord === "string" ? normalizeChord(chord) : null;
      if (normal && whyNotAllowed(normal) === null && !clean.includes(normal)) clean.push(normal);
    }
    result[id] = clean;
  }
  return compact(commands, result);
}

/** For each chord, the commands that want it (the dispatcher picks among them). */
export function commandsByChord(
  commands: readonly CommandDef[],
  overrides: Overrides,
): Map<string, CommandDef[]> {
  const map = new Map<string, CommandDef[]>();
  for (const def of commands) {
    for (const chord of bindingsOf(def, overrides)) {
      const list = map.get(chord);
      if (list) list.push(def);
      else map.set(chord, [def]);
    }
  }
  return map;
}
