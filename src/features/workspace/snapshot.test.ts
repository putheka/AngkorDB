/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Tab } from "../../stores/tabs.ts";
import {
  captureWorkspace,
  parseWorkspace,
  serializeWorkspace,
  type SavedQuery,
  type SavedTable,
} from "./snapshot.ts";

const tabs: Tab[] = [
  {
    id: "table:public.users",
    kind: "table",
    schema: "public",
    name: "users",
    objectKind: "table",
    preview: false,
  },
  { id: "query:2", kind: "query", number: 2, preview: false },
  { id: "activity", kind: "activity", preview: false },
];

const query: SavedQuery = {
  text: "select * from users where id = 1;\nselect 'ខ្មែរ 😀';",
  selection: { anchor: 7, head: 12 },
  editorHeight: 300,
  layout: "right",
  editorWidth: 600,
  historyOpen: true,
};

const table: SavedTable = {
  sort: [{ column: "created_at", dir: "desc" }],
  page: 2,
  pageSize: 100,
  layout: { order: ["id", "name"], hidden: ["secret"], widths: { name: 240 } },
  filter: {
    open: true,
    mode: "conditions",
    drafts: [{ id: "d1", column: "name", op: "iLike", values: ["%a%"] }],
    rawText: "",
    applied: { filters: [{ column: "name", op: "iLike", values: ["%a%"] }], rawWhere: null },
  },
  mode: "structure",
  section: "indexes",
};

const input = {
  tabs,
  activeId: "query:2",
  nextQueryNumber: 3,
  database: "shop",
  schema: "sales",
  queryViews: { "query:2": query, "query:9": { ...query, text: "closed tab" } },
  tableViews: { "table:public.users": table },
};

test("what is kept comes back the same, through the text it is saved as", () => {
  const saved = captureWorkspace(input);
  const back = parseWorkspace(serializeWorkspace(saved));
  assert.deepEqual(back, saved);
  assert.equal(back?.activeId, "query:2");
  assert.equal(back?.schema, "sales");
  assert.equal(back?.database, "shop");
  assert.equal(back?.queries["query:2"]?.text, query.text);
  assert.deepEqual(back?.tables["table:public.users"], table);
});

test("only open tabs keep a view, and only the kept fields of it", () => {
  const saved = captureWorkspace({
    ...input,
    queryViews: {
      "query:2": { ...query, running: true, lastRun: { rows: 1_000_000 } } as SavedQuery,
    },
  });
  assert.deepEqual(Object.keys(saved.queries), ["query:2"]);
  assert.deepEqual(saved.queries["query:2"], query);
  assert.equal(JSON.stringify(saved).includes("lastRun"), false);
});

test("anything that is not a workspace of this version restores nothing", () => {
  for (const text of ["", "nope", "[]", "null", '{"version":2,"tabs":[]}', '{"version":1}']) {
    assert.equal(parseWorkspace(text), null, text);
  }
});

test("tabs that can't be trusted are dropped, and the rest still opens", () => {
  const text = JSON.stringify({
    version: 1,
    tabs: [
      { id: "query:1", kind: "query", number: 1 },
      { id: "query:1", kind: "query", number: 1 }, // twice
      { id: "query:5", kind: "query", number: 2 }, // id does not match
      { id: "table:public.t", kind: "table", schema: "public", name: "t", objectKind: "nonsense" },
      {
        id: "table:public.v",
        kind: "table",
        schema: "public",
        name: "v",
        objectKind: "view",
        preview: true,
      },
      { id: "roles", kind: "roles" },
      { id: "activity", kind: "other" },
      "junk",
      null,
    ],
    activeId: "gone",
    nextQueryNumber: 1,
  });
  const workspace = parseWorkspace(text);
  assert.deepEqual(
    workspace?.tabs.map((t) => t.id),
    ["query:1", "table:public.v", "roles"],
  );
  // The front tab was lost: the first one is in front.
  assert.equal(workspace?.activeId, "query:1");
  assert.equal(workspace?.tabs[1]?.preview, true);
});

test("the next query number never reuses the number of a query that is back", () => {
  const text = JSON.stringify({
    version: 1,
    tabs: [{ id: "query:7", kind: "query", number: 7 }],
    activeId: "query:7",
    nextQueryNumber: 2,
  });
  assert.equal(parseWorkspace(text)?.nextQueryNumber, 8);
  const none = JSON.stringify({ version: 1, tabs: [], activeId: null, nextQueryNumber: "x" });
  assert.deepEqual(parseWorkspace(none)?.tabs, []);
  assert.equal(parseWorkspace(none)?.nextQueryNumber, 1);
  assert.equal(parseWorkspace(none)?.activeId, null);
  assert.equal(parseWorkspace(none)?.schema, null);
});

test("a query's cursor stays inside its text and its sizes stay sane", () => {
  const text = JSON.stringify({
    version: 1,
    tabs: [{ id: "query:1", kind: "query", number: 1 }],
    activeId: "query:1",
    nextQueryNumber: 2,
    queries: {
      "query:1": {
        text: "select 1",
        selection: { anchor: 500, head: -5 },
        editorHeight: 1,
        editorWidth: 99999,
        layout: "sideways",
        historyOpen: "yes",
      },
      "query:2": { text: "for a tab that is not there" },
    },
  });
  const workspace = parseWorkspace(text);
  assert.deepEqual(workspace?.queries["query:1"], {
    text: "select 1",
    selection: { anchor: 8, head: 0 },
    editorHeight: 96,
    layout: "below",
    editorWidth: 4000,
    historyOpen: false,
  });
  assert.deepEqual(Object.keys(workspace?.queries ?? {}), ["query:1"]);
  // No text, no view: the tab opens empty.
  const empty = parseWorkspace(
    JSON.stringify({
      version: 1,
      tabs: [{ id: "query:1", kind: "query", number: 1 }],
      queries: { "query:1": { selection: {} } },
    }),
  );
  assert.deepEqual(empty?.queries, {});
});

test("a table's sort, filter and layout are checked field by field", () => {
  const text = JSON.stringify({
    version: 1,
    tabs: [
      { id: "table:public.t", kind: "table", schema: "public", name: "t", objectKind: "table" },
    ],
    activeId: "table:public.t",
    nextQueryNumber: 1,
    tables: {
      "table:public.t": {
        sort: [{ column: "a", dir: "asc" }, { column: "b", dir: "up" }, 3],
        page: -4,
        pageSize: 5000000,
        layout: { order: ["a", 1, "b"], hidden: "no", widths: { a: 5, b: "wide", c: 300 } },
        filter: {
          open: true,
          mode: "raw",
          drafts: [
            { id: "x", column: "a", op: "eq", values: ["1", 2] },
            { id: "y", column: "a", op: "regex", values: [] },
          ],
          rawText: "a > 1",
          applied: {
            filters: [{ column: "a", op: "isNull", values: [] }, { op: "eq" }],
            rawWhere: 7,
          },
        },
        mode: "weird",
        section: "nope",
      },
    },
  });
  const view = parseWorkspace(text)?.tables["table:public.t"];
  assert.deepEqual(view?.sort, [{ column: "a", dir: "asc" }]);
  assert.equal(view?.page, 0);
  assert.equal(view?.pageSize, 10_000);
  assert.deepEqual(view?.layout, { order: ["a", "b"], hidden: [], widths: { a: 20, c: 300 } });
  assert.equal(view?.filter.open, true);
  assert.equal(view?.filter.mode, "raw");
  assert.deepEqual(view?.filter.drafts, [{ id: "x", column: "a", op: "eq", values: ["1"] }]);
  assert.equal(view?.filter.rawText, "a > 1");
  assert.deepEqual(view?.filter.applied, {
    filters: [{ column: "a", op: "isNull", values: [] }],
    rawWhere: null,
  });
  assert.equal(view?.mode, "data");
  assert.equal(view?.section, "columns");
});

test("a workspace kept before the database was recorded opens in the connection's own", () => {
  const older = Object.fromEntries(
    Object.entries(captureWorkspace(input)).filter(([key]) => key !== "database"),
  );
  assert.equal(parseWorkspace(JSON.stringify(older))?.database, null);
  assert.equal(parseWorkspace(JSON.stringify({ ...older, database: "" }))?.database, null);
});
