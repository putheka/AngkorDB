/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CompletionSchema } from "../../../bindings.ts";
import { analyze, tablesIn, tokenize } from "./analyze.ts";
import { buildIndex, quoteIfNeeded, suggest } from "./suggest.ts";

const column = (name: string, typeName: string) => ({ name, typeName });
const schema: CompletionSchema = {
  searchPath: ["public"],
  tables: [
    {
      schema: "public",
      name: "users",
      kind: "table",
      columns: [column("id", "bigint"), column("email", "citext"), column("Full Name", "text")],
    },
    {
      schema: "public",
      name: "orders",
      kind: "table",
      columns: [
        column("id", "bigint"),
        column("user_id", "bigint"),
        column("total", "numeric(12,2)"),
      ],
    },
    {
      schema: "billing",
      name: "invoices",
      kind: "table",
      columns: [column("id", "uuid"), column("order_id", "bigint")],
    },
    { schema: "public", name: "user_totals", kind: "view", columns: [column("user_id", "bigint")] },
  ],
  functions: [
    { schema: "public", name: "greet", signature: "(p_name text) → text" },
    { schema: "billing", name: "next_no", signature: "() → integer" },
  ],
};
const index = buildIndex(schema);

/** `SELECT u.| FROM users u`: `|` is the cursor. */
function at(sql: string) {
  const cursor = sql.indexOf("|");
  const text = sql.replace("|", "");
  return { text, cursor };
}
function offered(sql: string): string[] {
  const { text, cursor } = at(sql);
  return suggest(index, analyze(text, cursor)).map((s) => s.label);
}

test("after an alias and a dot: the columns of that table (the done-when)", () => {
  const found = offered("SELECT u.| FROM users u");
  assert.deepEqual(found, ["id", "email", "Full Name"]);
  const sugg = suggest(
    index,
    analyze(...(Object.values(at("SELECT u.| FROM users u")) as [string, number])),
  );
  assert.equal(sugg[0]?.detail, "bigint · u");
  // A column that needs quotes is written quoted.
  assert.equal(sugg[2]?.insert, '"Full Name"');
});

test("aliases: AS, a table name, a schema-qualified table, several tables", () => {
  assert.deepEqual(offered("SELECT o.| FROM orders AS o JOIN users u ON u.id = o.user_id"), [
    "id",
    "user_id",
    "total",
  ]);
  assert.deepEqual(offered("SELECT users.| FROM users"), ["id", "email", "Full Name"]);
  assert.deepEqual(offered("SELECT i.| FROM billing.invoices i"), ["id", "order_id"]);
  assert.deepEqual(offered("SELECT x.id, u.| FROM orders x, users u"), [
    "id",
    "email",
    "Full Name",
  ]);
  // `schema.table.` with no alias.
  assert.deepEqual(offered("SELECT billing.invoices.| FROM billing.invoices"), ["id", "order_id"]);
});

test("a prefix after the dot is part of the word, not of the qualifier", () => {
  const { text, cursor } = at("SELECT u.em| FROM users u");
  const found = analyze(text, cursor);
  assert.equal(found.kind, "member");
  if (found.kind === "member") {
    assert.deepEqual(found.qualifier, ["u"]);
    assert.equal(found.prefix, "em");
    assert.equal(found.from, text.indexOf("em"));
  }
});

test("after FROM and JOIN: tables, other schemas qualified; after a comma in FROM too", () => {
  for (const sql of [
    "SELECT * FROM |",
    "SELECT * FROM users u JOIN |",
    "SELECT * FROM users, |",
    "UPDATE |",
    "INSERT INTO |",
  ]) {
    const found = offered(sql);
    assert.ok(found.includes("users") && found.includes("orders"), sql);
    assert.ok(found.includes("user_totals"), sql);
    // Not on the search path: written with its schema.
    assert.ok(found.includes("billing.invoices") && !found.includes("invoices"), sql);
    assert.ok(found.includes("billing"), `${sql} offers the schema name`);
  }
  // After the table name it is an alias or a keyword, not another table.
  assert.notEqual(analyze("SELECT * FROM users |", 21).kind, "table");
  // A comma in a SELECT list is not a table list.
  assert.equal(analyze("SELECT a, | FROM users", 10).kind, "expression");
});

test("in a statement: columns of the tables it uses, aliases, and functions", () => {
  const found = offered("SELECT | FROM users u JOIN orders o ON o.user_id = u.id");
  for (const name of [
    "id",
    "email",
    "user_id",
    "total",
    "u",
    "o",
    "now",
    "date_trunc",
    "jsonb_set",
  ]) {
    assert.ok(found.includes(name), name);
  }
  // User functions: on the path unqualified, otherwise with their schema.
  assert.ok(found.includes("greet") && found.includes("billing.next_no"));
  // A table the statement doesn't use contributes nothing.
  assert.ok(!found.includes("order_id"));
  // WHERE and ON see the same tables.
  assert.ok(offered("SELECT * FROM users WHERE |").includes("email"));
  assert.ok(offered("UPDATE users SET | = 1").includes("email"));
  assert.ok(offered("DELETE FROM orders WHERE |").includes("total"));
});

test("functions show their signature and where the cursor goes", () => {
  const { text, cursor } = at("SELECT | FROM users");
  const list = suggest(index, analyze(text, cursor));
  const now = list.find((s) => s.label === "now");
  assert.equal(now?.detail, "() → timestamptz");
  assert.equal(now?.call, "none");
  const trunc = list.find((s) => s.label === "date_trunc");
  assert.equal(trunc?.detail, "(field text, source timestamp) → timestamp");
  assert.equal(trunc?.call, "args");
});

test("only the statement under the cursor counts", () => {
  const found = offered(
    "SELECT * FROM orders; SELECT | FROM users u; SELECT * FROM billing.invoices",
  );
  assert.ok(found.includes("email") && !found.includes("total") && !found.includes("order_id"));
});

test("nothing inside strings and comments; half-typed text works", () => {
  assert.equal(analyze("SELECT 'abc FR", 14).kind, "none");
  assert.equal(analyze("SELECT 1 -- FRO", 15).kind, "none");
  assert.equal(analyze("SELECT /* x", 11).kind, "none");
  assert.equal(analyze("SELECT $$ body FR", 17).kind, "none");
  // A table that doesn't exist yet gives no columns instead of an error.
  assert.deepEqual(offered("SELECT n.| FROM nosuch n"), []);
  assert.ok(offered("SELECT * FROM users u WHERE u.id = 1 AND |").includes("email"));
});

test("tokens and table references", () => {
  assert.deepEqual(
    tokenize('a.b, "C d"').map((t) => t.value),
    ["a", ".", "b", ",", "C d"],
  );
  const refs = tablesIn(
    tokenize(
      "SELECT 1 FROM public.users AS u, orders o LEFT JOIN billing.invoices ON true WHERE 1=1",
    ),
  );
  assert.deepEqual(refs, [
    { schema: "public", name: "users", alias: "u" },
    { schema: null, name: "orders", alias: "o" },
    { schema: "billing", name: "invoices", alias: null },
  ]);
  // Words after a table name that are not aliases.
  assert.deepEqual(tablesIn(tokenize("SELECT * FROM users WHERE id = 1 ORDER BY id")), [
    { schema: null, name: "users", alias: null },
  ]);
  assert.deepEqual(tablesIn(tokenize("INSERT INTO orders (user_id) VALUES (1)")), [
    { schema: null, name: "orders", alias: null },
  ]);
});

test("names are quoted only when they have to be", () => {
  assert.equal(quoteIfNeeded("users"), "users");
  assert.equal(quoteIfNeeded("Users"), '"Users"');
  assert.equal(quoteIfNeeded("full name"), '"full name"');
  assert.equal(quoteIfNeeded("order"), '"order"');
  assert.equal(quoteIfNeeded('we"ird'), '"we""ird"');
});

test("suggestions appear in well under 30 ms on a big schema (the done-when)", () => {
  const big: CompletionSchema = {
    searchPath: ["public"],
    tables: Array.from({ length: 1200 }, (_, i) => ({
      schema: "public",
      name: `table_${i}`,
      kind: "table" as const,
      columns: Array.from({ length: 20 }, (_, c) => column(`col_${c}`, "text")),
    })),
    functions: [],
  };
  const bigIndex = buildIndex(big);
  const sqls = [
    "SELECT t.| FROM table_700 t",
    "SELECT * FROM |",
    "SELECT | FROM table_1 a JOIN table_2 b ON a.col_1 = b.col_1",
  ];
  for (const sql of sqls) {
    const { text, cursor } = at(sql);
    const started = performance.now();
    for (let i = 0; i < 20; i++) suggest(bigIndex, analyze(text, cursor));
    const each = (performance.now() - started) / 20;
    assert.ok(each < 30, `${sql}: ${each.toFixed(2)} ms`);
  }
});
