/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CellValue } from "../editing/changes.ts";
import type { EditorKind } from "../editing/editorKind.ts";
import { formatRows, quoteIdent, sqlLiteral, type CopyColumn, type CopyRow } from "./formats.ts";
import { detectDelimiter, parseDelimited, rowsFromText, type PasteColumn } from "./parse.ts";

const v = (text: string): CellValue => ({ kind: "value", text });
const NULL: CellValue = { kind: "null" };
const DEFAULT: CellValue = { kind: "default" };
const table = { schema: "public", name: "users" };

const columns: CopyColumn[] = [
  { name: "id", kind: "integer" },
  { name: "name", kind: "text" },
  { name: "balance", kind: "decimal" },
  { name: "is_admin", kind: "bool" },
  { name: "profile", kind: "json" },
];
const rows: CopyRow[] = [
  {
    cells: [v("1"), v('Dara, "the" Sok'), v("1234.567891"), v("true"), v('{"a":[1,2]}')],
    key: [{ column: "id", kind: "integer", value: "1" }],
  },
  {
    cells: [v("9007199254740993"), v("សុភា 🙏\nline two\ttab"), NULL, v("false"), NULL],
    key: [{ column: "id", kind: "integer", value: "9007199254740993" }],
  },
  { cells: [DEFAULT, v(""), v("0"), NULL, v("[]")], key: null },
];

test("TSV: NULL is empty, awkward values are quoted", () => {
  const { text } = formatRows("tsv", columns, rows, table);
  assert.equal(
    text,
    [
      '1\t"Dara, ""the"" Sok"\t1234.567891\ttrue\t"{""a"":[1,2]}"',
      '9007199254740993\t"សុភា 🙏\nline two\ttab"\t\tfalse\t',
      "\t\t0\t\t[]",
    ].join("\n"),
  );
});

test("CSV: header row, NULL is nothing, an empty string is two quotes", () => {
  const { text } = formatRows("csv", columns, rows, table);
  assert.equal(
    text,
    [
      "id,name,balance,is_admin,profile",
      '1,"Dara, ""the"" Sok",1234.567891,true,"{""a"":[1,2]}"',
      '9007199254740993,"សុភា 🙏\nline two\ttab",,false,',
      ',"",0,,[]',
    ].join("\n"),
  );
});

test("JSON: numbers stay exact, json columns are embedded, NULL is null", () => {
  const { text } = formatRows("json", columns, rows, table);
  assert.equal(
    text,
    [
      "[",
      '  {"id": 1, "name": "Dara, \\"the\\" Sok", "balance": 1234.567891, "is_admin": true, "profile": {"a": [1, 2]}},',
      '  {"id": 9007199254740993, "name": "សុភា 🙏\\nline two\\ttab", "balance": null, "is_admin": false, "profile": null},',
      '  {"id": null, "name": "", "balance": 0, "is_admin": null, "profile": []}',
      "]",
    ].join("\n"),
  );
  assert.equal(JSON.parse(text).length, 3);
  assert.equal(formatRows("json", columns, [], table).text, "[]");
});

test("Markdown: pipes and line breaks are escaped", () => {
  const { text } = formatRows(
    "markdown",
    [
      { name: "a|b", kind: "text" },
      { name: "n", kind: "integer" },
    ],
    [{ cells: [v("x|y\nz"), NULL], key: null }],
    table,
  );
  assert.equal(text, "| a\\|b | n |\n| --- | --- |\n| x\\|y<br>z | NULL |");
});

test("INSERT: bare numbers and booleans, quoted text, DEFAULT and NULL", () => {
  const { text } = formatRows("insert", columns, rows, table);
  const head = `INSERT INTO "public"."users" ("id", "name", "balance", "is_admin", "profile") VALUES`;
  // The second row has a line break inside its text, which stays inside the string literal.
  assert.equal(
    text,
    [
      `${head} (1, 'Dara, "the" Sok', 1234.567891, true, '{"a":[1,2]}');`,
      `${head} (9007199254740993, 'សុភា 🙏\nline two\ttab', NULL, false, NULL);`,
      `${head} (DEFAULT, '', 0, NULL, '[]');`,
    ].join("\n"),
  );
});

test("UPDATE: SET the other columns, WHERE the key; rows without a key are skipped", () => {
  const { text, skipped } = formatRows("update", columns, rows, table);
  assert.equal(skipped, 1);
  assert.equal(
    text,
    [
      `UPDATE "public"."users" SET "name" = 'Dara, "the" Sok', "balance" = 1234.567891, "is_admin" = true, "profile" = '{"a":[1,2]}' WHERE "id" = 1;`,
      `UPDATE "public"."users" SET "name" = 'សុភា 🙏\nline two\ttab', "balance" = NULL, "is_admin" = false, "profile" = NULL WHERE "id" = 9007199254740993;`,
    ].join("\n"),
  );
  // Nothing but the key selected: nothing to set.
  const onlyKey = formatRows("update", [columns[0] as CopyColumn], rows, table);
  assert.equal(onlyKey.text, "");
  assert.equal(onlyKey.skipped, 3);
});

test("SQL literals escape quotes and never trust a number-looking string in a text column", () => {
  assert.equal(sqlLiteral(v("it's"), "text"), "'it''s'");
  assert.equal(sqlLiteral(v("1; DROP TABLE x"), "integer"), "'1; DROP TABLE x'");
  assert.equal(sqlLiteral(v("42"), "text"), "'42'");
  assert.equal(sqlLiteral(v("NaN"), "decimal"), "'NaN'");
  assert.equal(quoteIdent('we"ird'), '"we""ird"');
});

test("CSV round trip keeps text, NULL and empty strings apart", () => {
  const { text } = formatRows("csv", columns, rows, table);
  const parsed = parseDelimited(text, detectDelimiter(text));
  // Rows and fields are where they were.
  assert.equal(parsed.length, 4);
  assert.deepEqual(
    parsed[2]?.map((f) => [f.text, f.quoted]),
    [
      ["9007199254740993", false],
      ["សុភា 🙏\nline two\ttab", true],
      ["", false], // NULL
      ["false", false],
      ["", false],
    ],
  );
  assert.deepEqual(parsed[3]?.[1], { text: "", quoted: true }); // the empty string
  assert.deepEqual(parsed[1]?.[1], { text: 'Dara, "the" Sok', quoted: true });
});

test("TSV round trip keeps the values (Excel quoting)", () => {
  const { text } = formatRows("tsv", columns, rows, table);
  const parsed = parseDelimited(text, detectDelimiter(text));
  assert.equal(parsed.length, 3);
  assert.equal(parsed[0]?.[1]?.text, 'Dara, "the" Sok');
  assert.equal(parsed[1]?.[1]?.text, "សុភា 🙏\nline two\ttab");
  assert.equal(parsed[1]?.[0]?.text, "9007199254740993");
});

test("parsing: CRLF, trailing newline, blank lines, quotes", () => {
  assert.deepEqual(
    parseDelimited('a\tb\r\n\r\n"c\td"\te\n', "\t").map((r) => r.map((f) => f.text)),
    [
      ["a", "b"],
      ["c\td", "e"],
    ],
  );
  assert.deepEqual(parseDelimited("", ","), []);
  assert.deepEqual(parseDelimited("\n\n", ","), []);
  // A lone empty-string field is a row; a lone empty line is not.
  assert.deepEqual(
    parseDelimited('""\n', ",").map((r) => r.map((f) => f.text)),
    [[""]],
  );
  assert.equal(detectDelimiter("a,b"), ",");
  assert.equal(detectDelimiter("a\tb,c"), "\t");
  // A tab inside a quoted value on a later row does not turn a CSV into a TSV.
  assert.equal(detectDelimiter('a,b\n"x\ty",z'), ",");
  assert.equal(detectDelimiter('"a,b"\tc'), "\t");
  assert.equal(detectDelimiter("one line"), "\t");
});

const pasteColumns: PasteColumn[] = [
  { name: "id", kind: "integer", typeOid: 20, writable: false, hasDefault: true },
  { name: "code", kind: "text", typeOid: 25, writable: true, hasDefault: false },
  { name: "qty", kind: "integer", typeOid: 23, writable: true, hasDefault: true },
  { name: "note", kind: "text", typeOid: 25, writable: true, hasDefault: false },
];

test("paste maps fields to columns by position", () => {
  const result = rowsFromText("7\tA1\t5\thello\n8\tB2\t\t\n", pasteColumns);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.usedHeader, false);
  // The generated id was not written; an empty cell means DEFAULT where there is one, else NULL.
  assert.deepEqual(result.skipped, ["id"]);
  assert.deepEqual(result.rows, [
    { code: v("A1"), qty: v("5"), note: v("hello") },
    { code: v("B2"), qty: DEFAULT, note: NULL },
  ]);
});

test("paste with a header row matches columns by name, in any order", () => {
  const result = rowsFromText("QTY,code\n3,X\n4,Y\n", pasteColumns);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.usedHeader, true);
  assert.deepEqual(result.rows, [
    { qty: v("3"), code: v("X") },
    { qty: v("4"), code: v("Y") },
  ]);
});

test("paste: a quoted empty is an empty string, short rows leave the rest DEFAULT, long rows are trimmed", () => {
  const result = rowsFromText('1,"",2,n,extra1,extra2\n9,Z', pasteColumns);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.ignoredFields, 2);
  assert.deepEqual(result.rows, [{ code: v(""), qty: v("2"), note: v("n") }, { code: v("Z") }]);
});

test("paste refuses a value the column can't hold, naming the row and column", () => {
  const result = rowsFromText("1,A,2,x\n2,B,not a number,y", pasteColumns);
  assert.ok(!result.ok);
  if (result.ok) return;
  assert.match(result.error, /^Row 2, qty: /);
});

test("paste with nothing to paste, or only a header", () => {
  assert.ok(!rowsFromText("", pasteColumns).ok);
  assert.ok(!rowsFromText("   \n\n", pasteColumns).ok);
  const header = rowsFromText("id\tcode\tqty\tnote\n", pasteColumns);
  assert.ok(!header.ok);
});

test("a copy of rows pastes back as the same values (round trip)", () => {
  const kinds: Record<string, EditorKind> = {
    id: "integer",
    code: "text",
    qty: "integer",
    note: "text",
  };
  const copied: CopyRow[] = [
    { cells: [v("1"), v("a,b"), v("5"), v('say "hi"\nthere')], key: null },
    { cells: [v("2"), v("c"), v("6"), v("")], key: null },
  ];
  const cols: CopyColumn[] = Object.entries(kinds).map(([name, kind]) => ({ name, kind }));
  const { text } = formatRows("csv", cols, copied, table);
  const result = rowsFromText(text, pasteColumns);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.usedHeader, true);
  assert.deepEqual(result.rows, [
    { code: v("a,b"), qty: v("5"), note: v('say "hi"\nthere') },
    { code: v("c"), qty: v("6"), note: v("") },
  ]);
});
