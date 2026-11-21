/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SharedConnection } from "../../bindings.ts";
import { asksFor, defaultFileName, entriesOf, noSecrets } from "./connectionFile.ts";

const connection = (patch: Partial<SharedConnection>): SharedConnection => ({
  name: "n",
  host: "h",
  port: 5432,
  user: "u",
  database: "d",
  sslMode: "prefer",
  color: "none",
  group: null,
  safeMode: "off",
  needsPassword: false,
  needsSshSecret: false,
  needsSslKeySecret: false,
  ...patch,
});

test("the entries are the ticked connections with what was typed for each", () => {
  const secrets = new Map([[1, { ...noSecrets, password: "pw", sshSecret: "ssh" }]]);
  assert.deepEqual(entriesOf(3, new Set([0, 1]), secrets), [
    { index: 0, password: null, sshSecret: null, sslKeySecret: null },
    { index: 1, password: "pw", sshSecret: "ssh", sslKeySecret: null },
  ]);
  assert.deepEqual(entriesOf(3, new Set(), secrets), []);
  assert.deepEqual(entriesOf(2, new Set([5]), secrets), []);
});

test("what a connection will ask for", () => {
  assert.deepEqual(asksFor(connection({})), []);
  assert.deepEqual(asksFor(connection({ needsPassword: true })), ["password"]);
  assert.deepEqual(
    asksFor(
      connection({
        needsPassword: true,
        needsSshSecret: true,
        needsSslKeySecret: true,
        ssh: { host: "b", port: 22, user: "u", auth: { kind: "password" }, hasSecret: false },
      }),
    ),
    ["password", "SSH password", "TLS key passphrase"],
  );
  assert.deepEqual(
    asksFor(
      connection({
        needsSshSecret: true,
        ssh: {
          host: "b",
          port: 22,
          user: "u",
          auth: { kind: "privateKey", path: "/k" },
          hasSecret: false,
        },
      }),
    ),
    ["key passphrase"],
  );
});

test("a file name for the save dialog", () => {
  assert.equal(defaultFileName(new Date("2026-01-02T10:00:00Z")), "connections-2026-01-02.json");
});
