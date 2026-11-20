/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addChild,
  emptyNode,
  formatJson,
  getAt,
  isJsonNumber,
  parseJson,
  removeAt,
  renameKey,
  replaceAt,
  stringifyJson,
  tryParseJson,
} from "./json.ts";

test("numbers keep every digit and the way they were written", () => {
  const text = '{"big": 12345678901234567890, "money": 1.50, "tiny": -0.000001, "exp": 1E+400}';
  // JSON.parse would print 12345678901234567000 and 1.5.
  assert.equal(stringifyJson(parseJson(text)), text);
  assert.ok(!stringifyJson(parseJson(text)).includes("12345678901234567000"));
});

test("object keys stay in order and duplicates survive", () => {
  const node = parseJson('{"b": 1, "a": 2, "b": 3}');
  assert.equal(stringifyJson(node), '{"b": 1, "a": 2, "b": 3}');
});

test("strings: escapes, Khmer, emoji and surrogate pairs come back unchanged", () => {
  const text =
    '["say \\"hi\\"", "tab\\there", "សួស្តី", "🙏", "\\ud83d\\ude4f", "back\\\\slash", "\\u0041"]';
  const node = parseJson(text);
  const items = node.type === "array" ? node.items : [];
  assert.deepEqual(
    items.map((i) => (i.type === "string" ? i.value : null)),
    ['say "hi"', "tab\there", "សួស្តី", "🙏", "🙏", "back\\slash", "A"],
  );
  // And writing them out gives text that JSON.parse reads the same way.
  assert.deepEqual(JSON.parse(stringifyJson(node)), JSON.parse(text));
});

test("every kind of value, and the empty containers", () => {
  const text =
    '{"a": [], "b": {}, "c": null, "d": true, "e": false, "f": "", "g": [1, [2, {"h": 3}]]}';
  assert.equal(stringifyJson(parseJson(text)), text);
  assert.equal(stringifyJson(parseJson("  \n\t 42 \r\n")), "42");
  assert.equal(stringifyJson(parseJson('"just a string"')), '"just a string"');
});

test("pretty and compact forms", () => {
  const text = '{"a": [1, 2], "b": {"c": null}, "d": [], "e": {}}';
  const pretty = formatJson(text, 2);
  assert.equal(
    pretty,
    '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  },\n  "d": [],\n  "e": {}\n}',
  );
  assert.equal(formatJson(pretty, null), text);
  assert.equal(formatJson(text, null, false), '{"a":[1,2],"b":{"c":null},"d":[],"e":{}}');
});

test("invalid JSON is refused with a position", () => {
  const cases: [string, string, number, number][] = [
    ["", "Empty", 1, 1],
    ["   ", "Empty", 1, 4],
    ["{", "expected", 1, 2],
    ['{"a": }', "Unexpected", 1, 7],
    ['{"a" 1}', 'expected ":"', 1, 6],
    ["[1, 2", "expected", 1, 6],
    ["[1,]", "Unexpected", 1, 4],
    ["{'a': 1}", "expected a", 1, 2],
    ['{"a": 1} extra', "after the end", 1, 10],
    ['"open', "never closed", 1, 1],
    ['"bad \\x escape"', "Invalid escape", 1, 6],
    ['"bad \\u12G4"', "Invalid \\u", 1, 6],
    ['"line\nbreak"', "control character", 1, 6],
    ["01", "Invalid number", 1, 1],
    ["1.", "Invalid number", 1, 1],
    ["-", "Invalid number", 1, 1],
    ["NaN", "Unexpected", 1, 1],
    ["[1,\n 2,\n x]", "Unexpected", 3, 2],
  ];
  for (const [text, message, line, column] of cases) {
    const result = tryParseJson(text);
    assert.ok(!result.ok, JSON.stringify(text));
    if (result.ok) continue;
    assert.ok(
      result.error.message.includes(message),
      `${JSON.stringify(text)}: ${result.error.message}`,
    );
    assert.deepEqual(
      [result.error.line, result.error.column],
      [line, column],
      JSON.stringify(text),
    );
  }
});

test("nesting too deep is an error, not a crash", () => {
  const deep = "[".repeat(2000) + "]".repeat(2000);
  const result = tryParseJson(deep);
  assert.ok(!result.ok && result.error.message.includes("too deeply"));
});

test("isJsonNumber follows the JSON grammar", () => {
  for (const ok of [
    "0",
    "-0",
    "12",
    "1.5",
    "-0.25",
    "1e5",
    "1E-5",
    "1.5e+10",
    "12345678901234567890",
  ]) {
    assert.ok(isJsonNumber(ok), ok);
  }
  for (const bad of ["", "01", "1.", ".5", "+1", "1e", "0x10", "NaN", "1 2", "--1"]) {
    assert.ok(!isJsonNumber(bad), bad);
  }
});

test("editing a tree changes only what was edited", () => {
  const root = parseJson('{"name": "Dara", "tags": ["a", "b"], "n": 12345678901234567890}');

  // Change a value.
  const renamed = replaceAt(root, [0], { type: "string", value: "Sok" });
  assert.equal(
    stringifyJson(renamed),
    '{"name": "Sok", "tags": ["a", "b"], "n": 12345678901234567890}',
  );
  // The original is untouched.
  assert.equal(
    stringifyJson(root),
    '{"name": "Dara", "tags": ["a", "b"], "n": 12345678901234567890}',
  );

  // Change a value inside an array.
  assert.equal(
    stringifyJson(replaceAt(root, [1, 1], { type: "string", value: "z" })),
    '{"name": "Dara", "tags": ["a", "z"], "n": 12345678901234567890}',
  );

  // Remove an array item and an object entry.
  assert.equal(
    stringifyJson(removeAt(root, [1, 0])),
    '{"name": "Dara", "tags": ["b"], "n": 12345678901234567890}',
  );
  assert.equal(
    stringifyJson(removeAt(root, [0])),
    '{"tags": ["a", "b"], "n": 12345678901234567890}',
  );

  // Add to an array and an object.
  assert.equal(
    stringifyJson(addChild(root, [1], { type: "string", value: "c" })),
    '{"name": "Dara", "tags": ["a", "b", "c"], "n": 12345678901234567890}',
  );
  assert.equal(
    stringifyJson(addChild(root, [], emptyNode("null"), "extra")),
    '{"name": "Dara", "tags": ["a", "b"], "n": 12345678901234567890, "extra": null}',
  );

  // Rename a key.
  assert.equal(
    stringifyJson(renameKey(root, [2], "big")),
    '{"name": "Dara", "tags": ["a", "b"], "big": 12345678901234567890}',
  );

  assert.deepEqual(getAt(root, [1, 0]), { type: "string", value: "a" });
  assert.equal(getAt(root, [9]), undefined);
  assert.equal(getAt(root, [0, 0]), undefined);
});

test("editing the root and nonsense paths are safe", () => {
  const root = parseJson("[1, 2]");
  assert.equal(stringifyJson(replaceAt(root, [], emptyNode("object"))), "{}");
  assert.equal(removeAt(root, []), root);
  assert.equal(stringifyJson(addChild(parseJson("1"), [], emptyNode("null"))), "1");
  assert.equal(stringifyJson(renameKey(root, [0], "x")), "[1, 2]");
  assert.equal(stringifyJson(removeAt(root, [5])), "[1, 2]");
});
