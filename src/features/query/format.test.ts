/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { dollarQuoted, FormatError, formatSql } from "./format.ts";
import { DEFAULT_PREFS, sanitizePrefs } from "./prefs.ts";

const upper = { keywordCase: "upper", tabWidth: 2 } as const;

test("a select is laid out one clause per line with upper-case keywords", () => {
  assert.equal(
    formatSql("select a,b from t where x=1 and y in (1,2)", upper),
    "SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y IN (1, 2)",
  );
});

test("keyword case and tab width are followed", () => {
  const lower = formatSql("SELECT a FROM t", { keywordCase: "lower", tabWidth: 4 });
  assert.equal(lower, "select\n    a\nfrom\n    t");
  const kept = formatSql("Select a From t", { keywordCase: "preserve", tabWidth: 2 });
  assert.match(kept, /^Select\n {2}a\nFrom\n {2}t$/);
});

test("statements stay separate, with a blank line between", () => {
  const out = formatSql("select 1; select 2", upper);
  assert.equal(out, "SELECT\n  1;\n\nSELECT\n  2");
});

test("a function body between $$ is kept exactly", () => {
  const body = "$$ begin  if x   then  y := 'a  b'; end if;\n\t  return  1 ; end $$";
  const sql = `create function f() returns int as ${body} language plpgsql; select  1`;
  const out = formatSql(sql, upper);
  assert.ok(out.includes(body), out);
  assert.match(out, /SELECT\n {2}1$/);
});

test("tagged bodies, quotes inside bodies and DO blocks are kept exactly", () => {
  for (const sql of [
    "create function g() returns text as $body$ begin  return 'it''s' ; end $body$ language plpgsql",
    "do $$ begin raise notice 'a  b'; end $$",
    "create function h() returns int as $f$ select  1  -- it's  $f$ language sql",
    "select $$ it's  $$, $a$  x  $a$ from   t",
  ]) {
    const out = formatSql(sql, upper);
    for (const body of dollarQuoted(sql)) assert.ok(out.includes(body), `${body} in ${out}`);
  }
});

test("dollarQuoted ignores parameters, strings, names and comments", () => {
  assert.deepEqual(dollarQuoted("select $1, $2 from t where a = $1"), []);
  assert.deepEqual(
    dollarQuoted("select '$$ not $$', \"$x$\" -- $$ no $$\n, 1 /* $$ nor $$ */"),
    [],
  );
  assert.deepEqual(dollarQuoted("select a$b$c from t"), []);
  assert.deepEqual(dollarQuoted("select $$a$$, $t$b$$c$t$"), ["$$a$$", "$t$b$$c$t$"]);
  // Not closed: the rest of the text counts as the body.
  assert.deepEqual(dollarQuoted("select 1; do $$ begin"), ["$$ begin"]);
  // E'' strings escape quotes with a backslash.
  assert.deepEqual(dollarQuoted("select E'it\\'s $$ x $$', $$real$$"), ["$$real$$"]);
});

test("text that can't be formatted is reported, not mangled", () => {
  assert.throws(
    () =>
      formatSql("create function h() returns int as $$ select $$nested$$; $$ language sql", upper),
    FormatError,
  );
  assert.equal(formatSql("   ", upper), "   ");
});

test("a final line break survives", () => {
  assert.equal(formatSql("select 1\n", upper), "SELECT\n  1\n");
});

test("sanitizePrefs keeps valid values and replaces the rest with defaults", () => {
  assert.deepEqual(sanitizePrefs(undefined), DEFAULT_PREFS);
  assert.deepEqual(sanitizePrefs("nope"), DEFAULT_PREFS);
  const ok = {
    fontFamily: "menlo",
    fontSize: 16,
    tabSize: 4,
    lineNumbers: false,
    wordWrap: true,
    vim: true,
    keywordCase: "lower",
  };
  assert.deepEqual(sanitizePrefs(ok), ok);
  assert.deepEqual(
    sanitizePrefs({
      fontFamily: "comic",
      fontSize: 99,
      tabSize: 3,
      lineNumbers: "yes",
      keywordCase: "shout",
    }),
    DEFAULT_PREFS,
  );
  assert.equal(sanitizePrefs({ fontSize: 14 }).fontSize, 14);
  assert.equal(sanitizePrefs({ fontFamily: "toString" }).fontFamily, "system");
});
