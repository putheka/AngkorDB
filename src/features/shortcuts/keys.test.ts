/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assignChord,
  bindingsOf,
  commandsByChord,
  findConflicts,
  removeChord,
  resetCommand,
  sanitizeOverrides,
} from "./bindings.ts";
import { COMMANDS, commandById } from "./commands.ts";
import {
  chordIdOf,
  displayChord,
  formatChordId,
  normalizeChord,
  parseChord,
  toCodeMirrorKey,
  whyNotAllowed,
} from "./keys.ts";

const press = (
  code: string,
  mods: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

test("a key press becomes a chord, with modifiers in one fixed order", () => {
  assert.equal(chordIdOf(press("KeyP", { meta: true, shift: true })), "Shift+Cmd+KeyP");
  assert.equal(chordIdOf(press("Tab", { ctrl: true })), "Ctrl+Tab");
  assert.equal(chordIdOf(press("BracketRight", { meta: true, alt: true })), "Alt+Cmd+BracketRight");
  // A modifier on its own is not a chord yet.
  for (const code of [
    "ShiftLeft",
    "MetaRight",
    "AltLeft",
    "ControlLeft",
    "CapsLock",
    "Unidentified",
    "",
  ]) {
    assert.equal(chordIdOf(press(code, { meta: true })), null, code);
  }
});

test("chords are read from text, in any order, and rejected when they make no sense", () => {
  assert.deepEqual(parseChord("Cmd+Shift+KeyP"), {
    ctrl: false,
    alt: false,
    shift: true,
    cmd: true,
    code: "KeyP",
  });
  assert.equal(normalizeChord("Cmd+Shift+KeyP"), "Shift+Cmd+KeyP");
  assert.equal(normalizeChord("Shift+Cmd+KeyP"), "Shift+Cmd+KeyP");
  for (const bad of ["", "Cmd", "Cmd+Shift", "Cmd+Cmd+KeyP", "Meta+KeyP", "Cmd+", "+KeyP"]) {
    assert.equal(parseChord(bad), null, bad);
  }
  for (const id of ["Cmd+KeyP", "Ctrl+Alt+Shift+Cmd+Digit1", "Ctrl+Tab"]) {
    const chord = parseChord(id);
    assert.ok(chord, id);
    assert.equal(formatChordId(chord), normalizeChord(id));
  }
});

test("chords are shown as on a Mac menu", () => {
  assert.equal(displayChord("Cmd+KeyT"), "⌘T");
  assert.equal(displayChord("Cmd+Shift+KeyP"), "⇧⌘P");
  assert.equal(displayChord("Alt+Cmd+BracketRight"), "⌥⌘]");
  assert.equal(displayChord("Ctrl+Tab"), "⌃⇥");
  assert.equal(displayChord("Cmd+Shift+Backspace"), "⇧⌘⌫");
  assert.equal(displayChord("Cmd+Digit0"), "⌘0");
  assert.equal(displayChord("Cmd+Period"), "⌘.");
  assert.equal(displayChord("Cmd+Enter"), "⌘↩");
});

test("chords become CodeMirror keys", () => {
  assert.equal(toCodeMirrorKey("Cmd+Enter"), "Mod-Enter");
  assert.equal(toCodeMirrorKey("Cmd+Shift+Enter"), "Shift-Mod-Enter");
  assert.equal(toCodeMirrorKey("Cmd+Shift+KeyF"), "Shift-Mod-f");
  assert.equal(toCodeMirrorKey("Cmd+Slash"), "Mod-/");
  assert.equal(toCodeMirrorKey("Cmd+KeyD"), "Mod-d");
  assert.equal(toCodeMirrorKey("Ctrl+Alt+Digit1"), "Ctrl-Alt-1");
  assert.equal(toCodeMirrorKey("Cmd+IntlBackslash"), null);
  assert.equal(toCodeMirrorKey("nonsense"), null);
});

test("macOS keys and plain typing keys can't be taken", () => {
  for (const reserved of [
    "Cmd+KeyQ",
    "Cmd+KeyC",
    "Cmd+KeyV",
    "Cmd+KeyZ",
    "Cmd+Shift+KeyZ",
    "Cmd+Comma",
  ]) {
    assert.ok(whyNotAllowed(reserved), reserved);
  }
  for (const typing of ["KeyA", "Digit1", "Space", "Enter", "Backspace", "Shift+KeyA", "Period"]) {
    assert.match(whyNotAllowed(typing) ?? "", /plain key/, typing);
  }
  for (const fine of [
    "Cmd+KeyY",
    "Alt+KeyA",
    "Ctrl+KeyJ",
    "Cmd+Shift+KeyY",
    "F5",
    "Tab",
    "Ctrl+Tab",
  ]) {
    assert.equal(whyNotAllowed(fine), null, fine);
  }
});

test("every command has a clear identity: unique ids, valid chords, no clash among the defaults", () => {
  const ids = COMMANDS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const def of COMMANDS) {
    for (const chord of def.keys) {
      assert.equal(normalizeChord(chord), chord, `${def.id}: ${chord} is not written canonically`);
    }
  }
  for (const def of COMMANDS) {
    for (const chord of def.keys) {
      assert.deepEqual(
        findConflicts(COMMANDS, {}, def.id, chord).map((c) => c.id),
        [],
        `${def.id} ${chord}`,
      );
    }
  }
});

test("⌘F is shared by the sidebar and the table because they never both apply", () => {
  const table = commandById("table.filter");
  const sidebar = commandById("sidebar.filter");
  assert.ok(table && sidebar);
  assert.ok(
    bindingsOf(table, {}).includes("Cmd+KeyF") && bindingsOf(sidebar, {}).includes("Cmd+KeyF"),
  );
  assert.equal(commandsByChord(COMMANDS, {}).get("Cmd+KeyF")?.length, 2);
  // The same key for two app-wide commands would be a conflict.
  assert.deepEqual(
    findConflicts(COMMANDS, {}, "app.reload", "Cmd+KeyT").map((c) => c.id),
    ["tabs.new"],
  );
});

test("a new key is added, a taken one is refused unless replacing, and replacing takes it away", () => {
  const added = assignChord(COMMANDS, {}, "app.reload", "Cmd+KeyY");
  assert.ok(added.ok);
  assert.deepEqual(added.overrides["app.reload"], ["Cmd+KeyR", "Cmd+KeyY"]);

  const taken = assignChord(COMMANDS, {}, "app.reload", "Cmd+KeyT");
  assert.ok(!taken.ok);
  assert.deepEqual(
    taken.conflicts.map((c) => c.id),
    ["tabs.new"],
  );
  assert.match(taken.reason, /New query tab/);

  const stolen = assignChord(COMMANDS, {}, "app.reload", "Cmd+KeyT", true);
  assert.ok(stolen.ok);
  assert.deepEqual(stolen.overrides["tabs.new"], []);
  assert.deepEqual(
    stolen.displaced.map((c) => c.id),
    ["tabs.new"],
  );
  assert.deepEqual(
    commandsByChord(COMMANDS, stolen.overrides)
      .get("Cmd+KeyT")
      ?.map((c) => c.id),
    ["app.reload"],
  );

  // Other scopes may reuse a key: nothing else is in `editor` scope with ⌘Y.
  assert.ok(assignChord(COMMANDS, {}, "editor.format", "Cmd+KeyY").ok);
});

test("what can't be done is explained", () => {
  const refused = (id: string, chord: string) => {
    const result = assignChord(COMMANDS, {}, id, chord, true);
    assert.ok(!result.ok, `${id} ${chord}`);
    return result.reason;
  };
  assert.match(refused("nope", "Cmd+KeyY"), /no such command/);
  assert.match(refused("tabs.close", "Cmd+KeyY"), /menu bar/);
  assert.match(refused("app.reload", "Cmd+KeyQ"), /macOS/);
  assert.match(refused("app.reload", "KeyA"), /plain key/);
  assert.match(refused("app.reload", "garbage"), /not a key combination/);
  // Even replacing can't take a key from the menu bar's.
  assert.match(refused("app.reload", "Cmd+KeyW"), /can't change/);
});

test("removing, resetting and keeping only real changes", () => {
  const changed = assignChord(COMMANDS, {}, "app.reload", "Cmd+KeyY");
  assert.ok(changed.ok);
  const without = removeChord(COMMANDS, changed.overrides, "app.reload", "Cmd+KeyR");
  assert.deepEqual(without["app.reload"], ["Cmd+KeyY"]);
  assert.deepEqual(removeChord(COMMANDS, without, "app.reload", "Cmd+KeyY")["app.reload"], []);
  // Back to what the defaults say: no override left.
  assert.deepEqual(removeChord(COMMANDS, changed.overrides, "app.reload", "Cmd+KeyY"), {});
  assert.deepEqual(resetCommand(changed.overrides, "app.reload"), {});
  assert.deepEqual(removeChord(COMMANDS, {}, "tabs.close", "Cmd+KeyW"), {});
});

test("stored changes are checked: unknown commands, odd chords and fixed commands are dropped", () => {
  assert.deepEqual(sanitizeOverrides(COMMANDS, null), {});
  assert.deepEqual(sanitizeOverrides(COMMANDS, []), {});
  assert.deepEqual(sanitizeOverrides(COMMANDS, "x"), {});
  assert.deepEqual(
    sanitizeOverrides(COMMANDS, {
      "app.reload": ["Cmd+KeyY", "Cmd+KeyY", "garbage", 7, "Cmd+KeyQ", "KeyA", "Cmd+Alt+KeyY"],
      "tabs.close": ["Cmd+KeyY"],
      "no.such": ["Cmd+KeyY"],
      "tabs.new": "Cmd+KeyT",
      "app.sidebar": ["Cmd+Digit0"],
    }),
    { "app.reload": ["Cmd+KeyY", "Alt+Cmd+KeyY"] },
  );
  // An empty list means "no key for this command", and is kept.
  assert.deepEqual(sanitizeOverrides(COMMANDS, { "app.reload": [] }), { "app.reload": [] });
});
