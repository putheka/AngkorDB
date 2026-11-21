/**
 * Key chords (ANG-52): how a shortcut is written, read from a key press, shown to people, and
 * handed to CodeMirror. Pure; no alias imports (unit-tested in Node).
 *
 * A chord is `Cmd+Shift+KeyP`: modifiers in a fixed order (Ctrl, Alt, Shift, Cmd), then the
 * physical key as `KeyboardEvent.code`. `code` rather than `key`, so that a shortcut is the same
 * place on every keyboard layout (⇧[ types `{` on a US layout and something else elsewhere).
 */

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  cmd: boolean;
  /** `KeyboardEvent.code` of the key: "KeyP", "Digit0", "Enter", "BracketLeft", ... */
  code: string;
}

/** The part of a keyboard event that matters; a real `KeyboardEvent` has it. */
export interface KeyLike {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
]);

/** `Ctrl+Alt+Shift+Cmd+Code`, in that order. */
export function formatChordId(chord: Chord): string {
  return [
    chord.ctrl ? "Ctrl" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
    chord.cmd ? "Cmd" : "",
    chord.code,
  ]
    .filter(Boolean)
    .join("+");
}

const MODIFIERS: Record<string, keyof Omit<Chord, "code">> = {
  Ctrl: "ctrl",
  Alt: "alt",
  Shift: "shift",
  Cmd: "cmd",
};

/** The keys a chord can be made of (`KeyboardEvent.code` values). */
const KNOWN_CODE =
  /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|NumpadEnter|F([1-9]|1[0-9]|20)|Arrow(Up|Down|Left|Right)|Enter|Backspace|Delete|Tab|Escape|Space|Period|Comma|Slash|Backslash|IntlBackslash|BracketLeft|BracketRight|Minus|Equal|Semicolon|Quote|Backquote|Home|End|PageUp|PageDown)$/;

/** The chord written as `text`, or `null` when it isn't one (unknown modifier or key, no key). */
export function parseChord(text: string): Chord | null {
  const parts = text.split("+");
  const code = parts.pop();
  if (!code || !KNOWN_CODE.test(code)) return null;
  const chord: Chord = { ctrl: false, alt: false, shift: false, cmd: false, code };
  for (const part of parts) {
    const flag = MODIFIERS[part];
    if (!flag || chord[flag]) return null;
    chord[flag] = true;
  }
  return chord;
}

/** The canonical spelling of a chord that may have been written in another order. */
export function normalizeChord(text: string): string | null {
  const chord = parseChord(text);
  return chord ? formatChordId(chord) : null;
}

/** The chord a key press makes; `null` for a modifier on its own (nothing to bind yet). */
export function chordOf(event: KeyLike): Chord | null {
  if (!event.code || event.code === "Unidentified" || MODIFIER_CODES.has(event.code)) return null;
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    cmd: event.metaKey,
    code: event.code,
  };
}

export const chordIdOf = (event: KeyLike): string | null => {
  const chord = chordOf(event);
  return chord ? formatChordId(chord) : null;
};

const SYMBOLS: Record<string, string> = {
  Enter: "↩",
  NumpadEnter: "⌤",
  Backspace: "⌫",
  Delete: "⌦",
  Tab: "⇥",
  Escape: "⎋",
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Period: ".",
  Comma: ",",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  PageUp: "⇞",
  PageDown: "⇟",
  Home: "↖",
  End: "↘",
};

/** The key as printed on a keycap: `KeyP` → P, `Digit0` → 0, `BracketLeft` → [. */
export function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  return SYMBOLS[code] ?? code;
}

/** How a chord is shown, as on a Mac menu: `⌃⌥⇧⌘` then the key (`Cmd+Shift+KeyP` → ⇧⌘P). */
export function displayChord(chordText: string): string {
  const chord = parseChord(chordText);
  if (!chord) return chordText;
  return `${chord.ctrl ? "⌃" : ""}${chord.alt ? "⌥" : ""}${chord.shift ? "⇧" : ""}${chord.cmd ? "⌘" : ""}${keyLabel(chord.code)}`;
}

const CM_KEYS: Record<string, string> = {
  Period: ".",
  Comma: ",",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Space: "Space",
};

/**
 * The chord in CodeMirror's spelling (`Mod-Shift-f`), or `null` for a key it can't name.
 * On a Mac `Mod` is ⌘.
 */
export function toCodeMirrorKey(chordText: string): string | null {
  const chord = parseChord(chordText);
  if (!chord) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(chord.code)) key = chord.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(chord.code)) key = chord.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(chord.code)) key = chord.code;
  else if (
    /^(Enter|Backspace|Delete|Tab|Escape|Arrow(Up|Down|Left|Right)|Home|End|PageUp|PageDown)$/.test(
      chord.code,
    )
  ) {
    key = chord.code;
  } else if (chord.code in CM_KEYS) key = CM_KEYS[chord.code] as string;
  else return null;
  return [
    chord.ctrl ? "Ctrl" : "",
    chord.alt ? "Alt" : "",
    chord.shift ? "Shift" : "",
    chord.cmd ? "Mod" : "",
    key,
  ]
    .filter(Boolean)
    .join("-");
}

/**
 * Chords that can't be given to a command: macOS or the native menu owns them, or a bare
 * letter would make typing impossible.
 */
const RESERVED = new Set([
  "Cmd+KeyQ", // quit
  "Cmd+KeyH", // hide
  "Alt+Cmd+KeyH",
  "Cmd+KeyM", // minimize
  "Cmd+KeyC", // copy, cut, paste, undo, redo, select all: the text fields need them
  "Cmd+KeyX",
  "Cmd+KeyV",
  "Cmd+KeyZ",
  "Shift+Cmd+KeyZ",
  "Cmd+KeyA",
  "Cmd+Comma", // settings, by macOS convention
  "Ctrl+Cmd+KeyF", // full screen
]);

/** Why a chord can't be used, or `null` when it can. */
export function whyNotAllowed(chordText: string): string | null {
  const chord = parseChord(chordText);
  if (!chord) return "That is not a key combination.";
  if (RESERVED.has(formatChordId(chord))) return "macOS or the menu bar uses this one.";
  const typesText =
    !chord.cmd &&
    !chord.ctrl &&
    !chord.alt &&
    (/^(Key[A-Z]|Digit[0-9]|Space|Numpad[0-9])$/.test(chord.code) ||
      chord.code in CM_KEYS ||
      chord.code === "Enter" ||
      chord.code === "Backspace" ||
      chord.code === "Delete");
  if (typesText) return "Add ⌘, ⌃ or ⌥: a plain key has to stay for typing.";
  return null;
}
