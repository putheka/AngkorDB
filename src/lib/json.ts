/**
 * JSON that loses nothing (ANG-26).
 *
 * `JSON.parse` turns `12345678901234567890` into `12345678901234567000`, and `1.50` into `1.5`.
 * A jsonb column keeps numbers exactly, so editing one through `JSON.parse` / `JSON.stringify`
 * would quietly change data. This parser keeps every number as the text it was written as, and
 * keeps object keys in order, duplicates included (a `json` column does too).
 *
 * No imports: it also runs under plain Node, which is how it is tested.
 */

export type JsonNode =
  | { type: "object"; entries: JsonEntry[] }
  | { type: "array"; items: JsonNode[] }
  | { type: "string"; value: string }
  /** `raw` is the number as written: `-0.50`, `1e400`, `12345678901234567890`. */
  | { type: "number"; raw: string }
  | { type: "boolean"; value: boolean }
  | { type: "null" };

export interface JsonEntry {
  key: string;
  value: JsonNode;
}

export type JsonType = JsonNode["type"];

/** What is wrong, and where (1-based line and column). */
export interface JsonError {
  message: string;
  position: number;
  line: number;
  column: number;
}

export class JsonParseError extends Error implements JsonError {
  position: number;
  line: number;
  column: number;

  constructor(message: string, text: string, position: number) {
    super(message);
    this.name = "JsonParseError";
    this.position = position;
    const before = text.slice(0, position);
    this.line = before.split("\n").length;
    this.column = position - (before.lastIndexOf("\n") + 1) + 1;
  }
}

const MAX_DEPTH = 512;
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** Is `text` a JSON number exactly as written? */
export const isJsonNumber = (text: string) => NUMBER.test(text);

/** Parse a JSON document. Throws a {@link JsonParseError}. */
export function parseJson(text: string): JsonNode {
  let i = 0;
  const fail = (message: string, at = i): never => {
    throw new JsonParseError(message, text, at);
  };
  const skip = () => {
    while (i < text.length && " \t\n\r".includes(text.charAt(i))) i++;
  };
  const describe = () => (i >= text.length ? "the end of the text" : `"${text.charAt(i)}"`);

  function value(depth: number): JsonNode {
    if (depth > MAX_DEPTH) fail("Nested too deeply");
    skip();
    const c = text.charAt(i);
    if (c === "{") return object(depth);
    if (c === "[") return array(depth);
    if (c === '"') return { type: "string", value: string() };
    if (c === "-" || (c >= "0" && c <= "9")) return number();
    for (const [word, node] of [
      ["true", { type: "boolean", value: true }],
      ["false", { type: "boolean", value: false }],
      ["null", { type: "null" }],
    ] as const) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return node;
      }
    }
    return fail(`Unexpected ${describe()}, expected a value`);
  }

  function number(): JsonNode {
    const start = i;
    const match = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 4096));
    if (!match) return fail('Invalid number: a "-" needs digits after it');
    i += match[0].length;
    const next = text.charAt(i);
    if (/[0-9.eE+-]/.test(next)) return fail("Invalid number", start);
    return { type: "number", raw: match[0] };
  }

  function string(): string {
    const start = i;
    i++; // opening quote
    let out = "";
    for (;;) {
      if (i >= text.length) return fail("The string is never closed", start);
      const c = text.charAt(i);
      if (c === '"') {
        i++;
        return out;
      }
      if (c < " ") return fail("A line break or control character needs an escape in a string");
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const escape = text.charAt(i + 1);
      if (escape === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail("Invalid \\u escape", i);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else if (escape in ESCAPES) {
        out += ESCAPES[escape];
        i += 2;
      } else {
        return fail(`Invalid escape "\\${escape}"`, i);
      }
    }
  }

  function array(depth: number): JsonNode {
    i++; // [
    const items: JsonNode[] = [];
    skip();
    if (text.charAt(i) === "]") {
      i++;
      return { type: "array", items };
    }
    for (;;) {
      items.push(value(depth + 1));
      skip();
      const c = text.charAt(i);
      if (c === ",") {
        i++;
      } else if (c === "]") {
        i++;
        return { type: "array", items };
      } else {
        return fail(`Unexpected ${describe()}, expected "," or "]"`);
      }
    }
  }

  function object(depth: number): JsonNode {
    i++; // {
    const entries: JsonEntry[] = [];
    skip();
    if (text.charAt(i) === "}") {
      i++;
      return { type: "object", entries };
    }
    for (;;) {
      skip();
      if (text.charAt(i) !== '"') return fail(`Unexpected ${describe()}, expected a "key"`);
      const key = string();
      skip();
      if (text.charAt(i) !== ":") return fail(`Unexpected ${describe()}, expected ":"`);
      i++;
      entries.push({ key, value: value(depth + 1) });
      skip();
      const c = text.charAt(i);
      if (c === ",") {
        i++;
      } else if (c === "}") {
        i++;
        return { type: "object", entries };
      } else {
        return fail(`Unexpected ${describe()}, expected "," or "}"`);
      }
    }
  }

  skip();
  if (i >= text.length) fail("Empty: there is no JSON here");
  const root = value(0);
  skip();
  if (i < text.length) fail(`Unexpected ${describe()} after the end of the value`);
  return root;
}

/** `parseJson` that returns the error instead of throwing it. */
export function tryParseJson(
  text: string,
): { ok: true; node: JsonNode } | { ok: false; error: JsonError } {
  try {
    return { ok: true, node: parseJson(text) };
  } catch (error) {
    if (error instanceof JsonParseError) return { ok: false, error };
    throw error;
  }
}

/**
 * Write a node as text. Without `indent` it is on one line the way Postgres prints jsonb
 * (`{"a": 1, "b": [1, 2]}`); with one, one entry per line. `spaced: false` leaves out the
 * spaces after `,` and `:` (`{"a":1,"b":[1,2]}`).
 */
export function stringifyJson(node: JsonNode, indent: number | null = null, spaced = true): string {
  const colon = spaced ? ": " : ":";
  const write = (n: JsonNode, level: number): string => {
    switch (n.type) {
      case "string":
        return JSON.stringify(n.value);
      case "number":
        return n.raw;
      case "boolean":
        return n.value ? "true" : "false";
      case "null":
        return "null";
      case "array": {
        if (n.items.length === 0) return "[]";
        const parts = n.items.map((item) => write(item, level + 1));
        return wrap("[", "]", parts, level);
      }
      case "object": {
        if (n.entries.length === 0) return "{}";
        const parts = n.entries.map(
          (e) => `${JSON.stringify(e.key)}${colon}${write(e.value, level + 1)}`,
        );
        return wrap("{", "}", parts, level);
      }
    }
  };
  const wrap = (open: string, close: string, parts: string[], level: number) => {
    if (indent === null) return `${open}${parts.join(spaced ? ", " : ",")}${close}`;
    const inner = " ".repeat(indent * (level + 1));
    return `${open}\n${parts.map((p) => inner + p).join(",\n")}\n${" ".repeat(indent * level)}${close}`;
  };
  return write(node, 0);
}

/** Re-write JSON text: pretty (`indent`), on one line (`null`), or minified. Throws on invalid JSON. */
export const formatJson = (text: string, indent: number | null, spaced = true) =>
  stringifyJson(parseJson(text), indent, spaced);

// ---- Editing a tree. Every function returns a new tree; the old one is not touched. -------------

/** Where a node is: the index to take at each level (entry index in an object, item index in an array). */
export type JsonPath = readonly number[];

export function getAt(root: JsonNode, path: JsonPath): JsonNode | undefined {
  let node: JsonNode | undefined = root;
  for (const step of path) {
    if (node?.type === "object") node = node.entries[step]?.value;
    else if (node?.type === "array") node = node.items[step];
    else return undefined;
  }
  return node;
}

/** Replace the node at `path`. */
export function replaceAt(root: JsonNode, path: JsonPath, next: JsonNode): JsonNode {
  const [step, ...rest] = path;
  if (step === undefined) return next;
  if (root.type === "object") {
    return {
      type: "object",
      entries: root.entries.map((e, i) =>
        i === step ? { key: e.key, value: replaceAt(e.value, rest, next) } : e,
      ),
    };
  }
  if (root.type === "array") {
    return {
      type: "array",
      items: root.items.map((item, i) => (i === step ? replaceAt(item, rest, next) : item)),
    };
  }
  return root;
}

/** Take out the entry or item at `path` (not the root). */
export function removeAt(root: JsonNode, path: JsonPath): JsonNode {
  const parent = path.slice(0, -1);
  const last = path[path.length - 1];
  const container = getAt(root, parent);
  if (last === undefined || !container) return root;
  if (container.type === "object") {
    return replaceAt(root, parent, {
      type: "object",
      entries: container.entries.filter((_, i) => i !== last),
    });
  }
  if (container.type === "array") {
    return replaceAt(root, parent, {
      type: "array",
      items: container.items.filter((_, i) => i !== last),
    });
  }
  return root;
}

/** Add to the object or array at `path`: an object needs a `key`. */
export function addChild(root: JsonNode, path: JsonPath, child: JsonNode, key = ""): JsonNode {
  const container = getAt(root, path);
  if (container?.type === "object") {
    return replaceAt(root, path, {
      type: "object",
      entries: [...container.entries, { key, value: child }],
    });
  }
  if (container?.type === "array") {
    return replaceAt(root, path, { type: "array", items: [...container.items, child] });
  }
  return root;
}

/** Rename the key of the entry at `path`. */
export function renameKey(root: JsonNode, path: JsonPath, key: string): JsonNode {
  const parent = path.slice(0, -1);
  const last = path[path.length - 1];
  const container = getAt(root, parent);
  if (container?.type !== "object" || last === undefined) return root;
  return replaceAt(root, parent, {
    type: "object",
    entries: container.entries.map((e, i) => (i === last ? { key, value: e.value } : e)),
  });
}

/** A fresh value of a type, for "add" and for changing a value's type. */
export function emptyNode(type: JsonType): JsonNode {
  switch (type) {
    case "string":
      return { type, value: "" };
    case "number":
      return { type, raw: "0" };
    case "boolean":
      return { type, value: false };
    case "null":
      return { type };
    case "array":
      return { type, items: [] };
    case "object":
      return { type, entries: [] };
  }
}

/** How many entries or items a container has; 0 for anything else. */
export const childCount = (node: JsonNode) =>
  node.type === "object" ? node.entries.length : node.type === "array" ? node.items.length : 0;
