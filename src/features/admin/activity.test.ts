/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Backend } from "../../bindings.ts";
import {
  describeWait,
  formatSeconds,
  type LockNode,
  lockTree,
  oneLine,
  orphanWaiters,
  visibleBackends,
} from "./activity.ts";

function backend(pid: number, extra: Partial<Backend> = {}): Backend {
  return {
    pid,
    database: "shop",
    user: "app",
    application: "psql",
    client: "10.0.0.5",
    state: "active",
    waitEventType: null,
    waitEvent: null,
    stateSecs: 1,
    transactionSecs: 1,
    query: "SELECT 1",
    blockedBy: [],
    lockWait: null,
    isSelf: false,
    ...extra,
  };
}

const none = { hideIdle: false, text: "" };

test("the list's own connection is never shown", () => {
  const rows = [backend(1, { isSelf: true }), backend(2)];
  assert.deepEqual(
    visibleBackends(rows, none).map((b) => b.pid),
    [2],
  );
});

test("hiding idle keeps a connection that sits in a transaction", () => {
  const rows = [
    backend(1, { state: "idle" }),
    backend(2, { state: "idle in transaction" }),
    backend(3, { state: "idle in transaction (aborted)" }),
    backend(4, { state: null }),
  ];
  const shown = visibleBackends(rows, { hideIdle: true, text: "" }).map((b) => b.pid);
  assert.deepEqual(shown, [2, 3, 4]);
});

test("active first, longest running first; then waiting in a transaction; then the rest", () => {
  const rows = [
    backend(1, { state: "idle", stateSecs: 900 }),
    backend(2, { state: "idle in transaction", stateSecs: 5 }),
    backend(3, { stateSecs: 2 }),
    backend(4, { stateSecs: 30 }),
  ];
  assert.deepEqual(
    visibleBackends(rows, none).map((b) => b.pid),
    [4, 3, 2, 1],
  );
});

test("the search looks at the pid, user, application, database, address, state and query", () => {
  const rows = [
    backend(11, { query: "select pg_sleep(60)" }),
    backend(12, { user: "Reporting" }),
    backend(13, { application: "DBeaver" }),
    backend(14, { client: null, database: null, user: null, state: null, query: "" }),
  ];
  const find = (text: string) => visibleBackends(rows, { hideIdle: false, text }).map((b) => b.pid);
  assert.deepEqual(find("SLEEP"), [11]);
  assert.deepEqual(find("reporting"), [12]);
  assert.deepEqual(find("dbeaver"), [13]);
  assert.deepEqual(find("14"), [14]);
  assert.deepEqual(find("10.0.0.5").sort(), [11, 12, 13]);
});

test("the roots of the lock tree are the ones that block and wait for nobody", () => {
  const rows = [
    backend(1, { state: "idle in transaction", transactionSecs: 600 }),
    backend(2, { blockedBy: [1], stateSecs: 50 }),
    backend(3, { blockedBy: [2, 1], stateSecs: 20 }), // queued behind 2 as well as 1
    backend(4), // no part in it
  ];
  const tree = lockTree(rows);
  assert.equal(tree.length, 1);
  const root = tree[0] as LockNode;
  assert.equal(root.backend.pid, 1);
  // Each waiter is drawn once: 3 queues behind 2, so it hangs under 2.
  assert.deepEqual(
    root.waiters.map((w) => w.backend.pid),
    [2],
  );
  assert.deepEqual(
    root.waiters[0]?.waiters.map((w) => w.backend.pid),
    [3],
  );
  // But ending 1 frees both.
  assert.equal(root.waiting, 2);
  assert.equal(root.waiters[0]?.waiting, 1);
});

test("a waiter queues under the latest connection ahead of it", () => {
  const rows = [
    backend(1, { transactionSecs: 9 }),
    backend(2, { blockedBy: [1], stateSecs: 90 }),
    backend(3, { blockedBy: [1, 2], stateSecs: 60 }),
    backend(4, { blockedBy: [1, 2, 3], stateSecs: 30 }),
  ];
  const root = lockTree(rows)[0] as LockNode;
  assert.equal(root.waiting, 3);
  const chain: number[] = [];
  for (let n: LockNode | undefined = root; n; n = n.waiters[0]) chain.push(n.backend.pid);
  assert.deepEqual(chain, [1, 2, 3, 4]);
});

test("a waiter whose blocker is not in the list is reported apart", () => {
  const rows = [backend(2, { blockedBy: [99] }), backend(3, { blockedBy: [2] })];
  assert.deepEqual(
    lockTree(rows).map((n) => n.backend.pid),
    [2],
  );
  assert.deepEqual(
    orphanWaiters(rows).map((b) => b.pid),
    [2],
  );
});

test("a deadlock loop does not run forever", () => {
  const rows = [backend(1, { blockedBy: [2] }), backend(2, { blockedBy: [1] })];
  assert.deepEqual(lockTree(rows), []); // nobody is a root: both wait
});

test("several roots: the one with the oldest transaction comes first", () => {
  const rows = [
    backend(1, { transactionSecs: 10 }),
    backend(2, { transactionSecs: 99 }),
    backend(3, { blockedBy: [1, 2] }),
  ];
  const tree = lockTree(rows);
  assert.deepEqual(
    tree.map((n) => n.backend.pid),
    [2, 1],
  );
  assert.deepEqual(
    tree.map((n) => n.waiting),
    [1, 1],
  );
});

test("the wait reads as what it is", () => {
  assert.equal(
    describeWait(backend(1, { lockWait: "ShareLock on public.orders" })),
    "waits for ShareLock on public.orders",
  );
  assert.equal(
    describeWait(backend(1, { waitEventType: "IO", waitEvent: "DataFileRead" })),
    "IO: DataFileRead",
  );
  assert.equal(describeWait(backend(1)), "");
});

test("durations and long queries", () => {
  assert.equal(formatSeconds(null), "—");
  assert.equal(formatSeconds(0.25), "250 ms");
  assert.equal(formatSeconds(65), "1 min 5 s");
  assert.equal(formatSeconds(-3), "0 ms");
  assert.equal(oneLine("SELECT\n   a,\n\tb  FROM t"), "SELECT a, b FROM t");
  assert.equal(oneLine("x".repeat(500), 10), `${"x".repeat(9)}…`);
});
