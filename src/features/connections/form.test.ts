/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConnectionConfig } from "../../bindings.ts";
import {
  describeConnection,
  emptyForm,
  formFromConnection,
  formToConfig,
  applySshAlias,
  formToJumpSecretChange,
  formToSshSecretChange,
  formToSslKeySecretChange,
  secondsText,
  timeoutMs,
  validateForm,
  verifiesCertificate,
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
  sslFiles: null,
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
      jump: null,
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

test("certificate files round-trip through the form, and none is none", () => {
  assert.equal(formToConfig(formFromConnection(direct)).sslFiles, null);
  const files = {
    rootCert: "/certs/ca.crt",
    clientCert: "/certs/client.crt",
    clientKey: "/certs/client.key",
    hasKeySecret: true,
  };
  const form = formFromConnection({ ...direct, sslMode: "verify-full", sslFiles: files });
  assert.equal(form.sslRootCert, "/certs/ca.crt");
  assert.equal(form.hasSslKeySecret, true);
  assert.deepEqual(formToConfig(form).sslFiles, files);
  // Blank and padded paths.
  const root = { ...emptyForm, sslRootCert: "  /certs/ca.crt " };
  assert.deepEqual(formToConfig(root).sslFiles, {
    rootCert: "/certs/ca.crt",
    clientCert: null,
    clientKey: null,
    hasKeySecret: false,
  });
  assert.equal(formToConfig({ ...emptyForm, sslRootCert: "   " }).sslFiles, null);
});

test("the client key's passphrase is kept, replaced or removed; no key, no passphrase", () => {
  const base = { ...emptyForm, sslClientKey: "/k", sslClientCert: "/c", hasSslKeySecret: true };
  assert.deepEqual(formToSslKeySecretChange(base), { kind: "keep" });
  assert.deepEqual(formToSslKeySecretChange({ ...base, sslKeySecret: "p" }), {
    kind: "set",
    value: "p",
  });
  assert.deepEqual(formToSslKeySecretChange({ ...base, removeSslKeySecret: true }), {
    kind: "clear",
  });
  assert.deepEqual(formToSslKeySecretChange({ ...base, sslClientKey: "", sslKeySecret: "p" }), {
    kind: "keep",
  });
});

test("a client certificate and its key come together; only some modes look at the server's certificate", () => {
  const filled = { ...emptyForm, user: "u", database: "d" };
  assert.deepEqual(validateForm({ ...filled, sslClientCert: "/c" }), {
    sslClientCert: "Both, or neither",
  });
  assert.deepEqual(validateForm({ ...filled, sslClientKey: "/k" }), {
    sslClientCert: "Both, or neither",
  });
  assert.deepEqual(validateForm({ ...filled, sslClientCert: "/c", sslClientKey: "/k" }), {});
  assert.deepEqual(
    (["disable", "prefer", "require", "verify-ca", "verify-full"] as const).map(
      verifiesCertificate,
    ),
    [false, false, false, true, true],
  );
});

const viaBastion: ConnectionConfig = {
  ...direct,
  ssh: {
    host: "10.0.0.5",
    port: 22,
    user: "admin",
    auth: { kind: "password" },
    hasSecret: true,
    jump: {
      host: "gateway.example.com",
      port: 2200,
      user: "hop",
      auth: { kind: "privateKey", path: "~/.ssh/gateway" },
      hasSecret: true,
    },
  },
};

test("the jump host round-trips through the form, and no tunnel or no jump sends none", () => {
  const form = formFromConnection(viaBastion);
  assert.equal(form.useJump, true);
  assert.equal(form.jumpAuth, "privateKey");
  assert.equal(form.jumpKeyPath, "~/.ssh/gateway");
  assert.equal(form.hasJumpSecret, true);
  assert.deepEqual(formToConfig(form).ssh, viaBastion.ssh);
  assert.equal(formToConfig({ ...form, useJump: false }).ssh?.jump, null);
  assert.equal(formToConfig({ ...form, useSsh: false }).ssh, null);
  assert.equal(formToConfig(formFromConnection(direct)).ssh, null);
  assert.equal(
    describeConnection(viaBastion),
    "app@db.internal:5432/shop · via hop@gateway.example.com → admin@10.0.0.5",
  );
});

test("the jump host's secret is kept, replaced or removed on its own", () => {
  const base = {
    ...emptyForm,
    useSsh: true,
    useJump: true,
    jumpAuth: "password" as const,
    hasJumpSecret: true,
  };
  assert.deepEqual(formToJumpSecretChange(base), { kind: "keep" });
  assert.deepEqual(formToJumpSecretChange({ ...base, jumpSecret: "j" }), {
    kind: "set",
    value: "j",
  });
  assert.deepEqual(formToJumpSecretChange({ ...base, removeJumpSecret: true }), {
    kind: "clear",
  });
  // The ssh password of the server behind it does not leak into it.
  assert.deepEqual(formToJumpSecretChange({ ...base, sshSecret: "other" }), { kind: "keep" });
  assert.deepEqual(formToJumpSecretChange({ ...base, jumpAuth: "agent", jumpSecret: "j" }), {
    kind: "keep",
  });
  assert.deepEqual(formToJumpSecretChange({ ...base, useJump: false, jumpSecret: "j" }), {
    kind: "keep",
  });
});

test("the jump host's fields are checked only when there is a jump host", () => {
  const filled = {
    ...emptyForm,
    user: "u",
    database: "d",
    useSsh: true,
    sshHost: "h",
    sshUser: "u",
    sshKeyPath: "k",
  };
  assert.deepEqual(validateForm(filled), {});
  const on = { ...filled, useJump: true };
  assert.deepEqual(Object.keys(validateForm(on)).sort(), ["jumpHost", "jumpKeyPath", "jumpUser"]);
  const good = { ...on, jumpHost: "b", jumpUser: "u", jumpKeyPath: "~/.ssh/id" };
  assert.deepEqual(validateForm(good), {});
  assert.deepEqual(Object.keys(validateForm({ ...good, jumpPort: "0" })), ["jumpPort"]);
  assert.deepEqual(validateForm({ ...good, jumpAuth: "agent", jumpKeyPath: "" }), {});
  // Without a tunnel the jump host is not looked at.
  assert.deepEqual(validateForm({ ...on, useSsh: false }), {});
});

test("an entry of ~/.ssh/config fills the SSH section and keeps what it doesn't say", () => {
  const typed = {
    ...emptyForm,
    useSsh: true,
    sshHost: "db-prod",
    sshUser: "me",
    sshAuth: "agent" as const,
  };
  const filled = applySshAlias(typed, {
    host: "db-prod.internal",
    port: 2200,
    user: null,
    identityFile: "~/.ssh/work",
    jump: { host: "bastion.example.com", port: 22, user: "deploy", identityFile: null },
  });
  assert.equal(filled.sshHost, "db-prod.internal");
  assert.equal(filled.sshPort, "2200");
  assert.equal(filled.sshUser, "me");
  assert.equal(filled.sshAuth, "privateKey");
  assert.equal(filled.sshKeyPath, "~/.ssh/work");
  assert.equal(filled.useJump, true);
  assert.equal(filled.jumpHost, "bastion.example.com");
  assert.equal(filled.jumpUser, "deploy");
  assert.equal(filled.jumpAuth, typed.jumpAuth);
  const plain = applySshAlias(typed, {
    host: "h",
    port: 22,
    user: "u",
    identityFile: null,
    jump: null,
  });
  assert.equal(plain.sshAuth, "agent");
  assert.equal(plain.useJump, false);
});
