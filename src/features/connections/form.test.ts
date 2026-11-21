/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConnectionConfig } from "../../bindings.ts";
import {
  describeConnection,
  emptyForm,
  formFromConnection,
  formToConfig,
  formToSshSecretChange,
  secondsText,
  timeoutMs,
  validateForm,
} from "./form.ts";

test("the statement timeout is typed in seconds and kept in milliseconds", () => {
  assert.equal(timeoutMs("30"), 30_000);
  assert.equal(timeoutMs(" 0.5 "), 500);
  assert.equal(timeoutMs("1.2345"), 1235);
  // Blank, 0 and nonsense mean no limit; a day is the most.
  for (const none of ["", "  ", "0", "-5", "abc", "NaN"]) assert.equal(timeoutMs(none), null, none);
  assert.equal(timeoutMs("999999"), 86_400_000);

  assert.equal(secondsText(30_000), "30");
  assert.equal(secondsText(500), "0.5");
  assert.equal(secondsText(null), "");
  assert.equal(secondsText(undefined), "");
  assert.equal(secondsText(0), "");
});

test("the form refuses a timeout it can't read, and accepts none", () => {
  const filled = { ...emptyForm, user: "u", database: "d" };
  assert.deepEqual(validateForm(filled), {});
  assert.deepEqual(validateForm({ ...filled, statementTimeout: "30" }), {});
  assert.deepEqual(validateForm({ ...filled, statementTimeout: "0" }), {});
  for (const bad of ["abc", "-1", "100000"]) {
    assert.deepEqual(
      Object.keys(validateForm({ ...filled, statementTimeout: bad })),
      ["statementTimeout"],
      bad,
    );
  }
});

const direct: ConnectionConfig = {
  id: "1",
  name: "Prod",
  host: "db.internal",
  port: 5432,
  user: "app",
  database: "shop",
  sslMode: "prefer",
  color: "none",
  group: null,
  safeMode: "off",
  statementTimeoutMs: null,
  hasPassword: false,
  ssh: null,
};

test("a connection without a tunnel stays without one through the form", () => {
  const form = formFromConnection(direct);
  assert.equal(form.useSsh, false);
  assert.equal(formToConfig(form).ssh, null);
  assert.equal(describeConnection(direct), "app@db.internal:5432/shop");
});

test("the tunnel settings round-trip through the form", () => {
  const withKey: ConnectionConfig = {
    ...direct,
    ssh: {
      host: "bastion",
      port: 2222,
      user: "deploy",
      auth: { kind: "privateKey", path: "~/.ssh/id_ed25519" },
      hasSecret: true,
    },
  };
  const form = formFromConnection(withKey);
  assert.equal(form.useSsh, true);
  assert.equal(form.sshAuth, "privateKey");
  assert.equal(form.sshKeyPath, "~/.ssh/id_ed25519");
  assert.equal(form.hasSshSecret, true);
  assert.deepEqual(formToConfig(form).ssh, withKey.ssh);
  assert.equal(describeConnection(withKey), "app@db.internal:5432/shop · via deploy@bastion");

  const password = { ...form, sshAuth: "password" as const };
  assert.deepEqual(formToConfig(password).ssh?.auth, { kind: "password" });
  const agent = { ...form, sshAuth: "agent" as const };
  assert.deepEqual(formToConfig(agent).ssh?.auth, { kind: "agent" });
  // Turning the tunnel off sends none.
  assert.equal(formToConfig({ ...form, useSsh: false }).ssh, null);
});

test("the SSH secret is kept, replaced or removed like the password; the agent has none", () => {
  const base = { ...emptyForm, useSsh: true, sshAuth: "password" as const, hasSshSecret: true };
  assert.deepEqual(formToSshSecretChange(base), { kind: "keep" });
  assert.deepEqual(formToSshSecretChange({ ...base, sshSecret: "new" }), {
    kind: "set",
    value: "new",
  });
  assert.deepEqual(formToSshSecretChange({ ...base, removeSshSecret: true }), { kind: "clear" });
  // Typing a new one wins over "remove".
  assert.deepEqual(formToSshSecretChange({ ...base, removeSshSecret: true, sshSecret: "x" }), {
    kind: "set",
    value: "x",
  });
  assert.deepEqual(formToSshSecretChange({ ...base, sshAuth: "agent", sshSecret: "x" }), {
    kind: "keep",
  });
  assert.deepEqual(formToSshSecretChange({ ...base, useSsh: false, sshSecret: "x" }), {
    kind: "keep",
  });
});

test("the tunnel's fields are checked only when there is a tunnel", () => {
  const filled = { ...emptyForm, user: "u", database: "d" };
  assert.deepEqual(validateForm(filled), {});
  const on = { ...filled, useSsh: true };
  assert.deepEqual(Object.keys(validateForm(on)).sort(), ["sshHost", "sshKeyPath", "sshUser"]);
  const good = { ...on, sshHost: "b", sshUser: "u", sshKeyPath: "~/.ssh/id" };
  assert.deepEqual(validateForm(good), {});
  assert.deepEqual(Object.keys(validateForm({ ...good, sshPort: "70000" })), ["sshPort"]);
  assert.deepEqual(Object.keys(validateForm({ ...good, sshPort: "x" })), ["sshPort"]);
  // A password or the agent needs no key path.
  assert.deepEqual(validateForm({ ...good, sshAuth: "password", sshKeyPath: "" }), {});
  assert.deepEqual(validateForm({ ...good, sshAuth: "agent", sshKeyPath: "" }), {});
});
