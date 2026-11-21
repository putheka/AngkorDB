/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { SharedConnection } from "../../bindings.ts";
import {
  asksFor,
  defaultFileName,
  entriesOf,
  noSecrets,
  routeOf,
  warningsOf,
} from "./connectionFile.ts";

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
  needsSshJumpSecret: false,
  ...patch,
});

test("the entries carry the connections that were shown, with what was typed for each", () => {
  const items = [connection({ name: "a" }), connection({ name: "b" }), connection({ name: "c" })];
  const secrets = new Map([
    [1, { ...noSecrets, password: "pw", sshSecret: "ssh", sshJumpSecret: "j" }],
  ]);
  assert.deepEqual(entriesOf(items, new Set([0, 1]), secrets), [
    {
      connection: items[0],
      password: null,
      sshSecret: null,
      sslKeySecret: null,
      sshJumpSecret: null,
    },
    {
      connection: items[1],
      password: "pw",
      sshSecret: "ssh",
      sslKeySecret: null,
      sshJumpSecret: "j",
    },
  ]);
  assert.deepEqual(entriesOf(items, new Set(), secrets), []);
  assert.deepEqual(entriesOf(items.slice(0, 2), new Set([5]), secrets), []);
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

const gateway = {
  host: "gateway.example.com",
  port: 2200,
  user: "hop",
  auth: { kind: "agent" as const },
  hasSecret: false,
};
const tunnel = {
  host: "10.0.0.5",
  port: 22,
  user: "admin",
  auth: { kind: "privateKey" as const, path: "/keys/work" },
  hasSecret: false,
  jump: gateway,
};

test("every hop and file that decides where secrets go is listed, in connecting order", () => {
  assert.deepEqual(routeOf(connection({ sslMode: "require" })), [
    "Database u@h:5432/d",
    "SSL mode require",
  ]);
  assert.deepEqual(
    routeOf(
      connection({
        sslMode: "verify-full",
        ssh: tunnel,
        sslFiles: {
          rootCert: "/c/ca",
          clientCert: "/c/crt",
          clientKey: "/c/key",
          hasKeySecret: false,
        },
      }),
    ),
    [
      "Database u@h:5432/d",
      "SSH jump host hop@gateway.example.com:2200 (ssh-agent)",
      "SSH server admin@10.0.0.5:22 (key /keys/work)",
      "SSL mode verify-full",
      "Root certificate /c/ca",
      "Client certificate /c/crt",
      "Client key /c/key",
    ],
  );
});

test("a tunnel and an unchecked or missing encryption are called out", () => {
  assert.deepEqual(warningsOf(connection({ sslMode: "verify-full" })), []);
  assert.deepEqual(warningsOf(connection({ sslMode: "verify-ca" })), []);
  assert.deepEqual(warningsOf(connection({ sslMode: "disable" })), ["Not encrypted."]);
  assert.deepEqual(warningsOf(connection({ sslMode: "prefer" })), [
    "The server's certificate is not checked.",
  ]);
  const tunnelled = warningsOf(
    connection({ sslMode: "verify-full", ssh: { ...tunnel, jump: null } }),
  );
  assert.equal(tunnelled.length, 1);
  assert.match(tunnelled[0] ?? "", /an SSH server/);
  const chained = warningsOf(connection({ sslMode: "verify-full", ssh: tunnel }));
  assert.match(chained[0] ?? "", /two SSH servers/);
  assert.deepEqual(
    asksFor(
      connection({
        needsSshJumpSecret: true,
        ssh: { ...tunnel, jump: { ...gateway, auth: { kind: "password" } } },
      }),
    ),
    ["jump host password"],
  );
});
