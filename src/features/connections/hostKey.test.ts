/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import { hostKeyStop } from "./hostKey.ts";

const error = (code: string, extra: object = {}) => ({
  code,
  message: "m",
  pgCode: null,
  detail: null,
  hint: null,
  position: null,
  ...extra,
});

test("an unknown host key carries the fingerprint to show", () => {
  const stop = hostKeyStop(
    error("SSH_HOST_UNKNOWN", { detail: "SHA256:abc", hint: "ssh-ed25519 · bastion:22" }),
  );
  assert.deepEqual(stop, {
    kind: "unknown",
    fingerprint: "SHA256:abc",
    summary: "ssh-ed25519 · bastion:22",
    message: "m",
  });
});

test("a changed host key is told apart, so it is never offered for trust", () => {
  assert.equal(hostKeyStop(error("SSH_HOST_CHANGED", { detail: "SHA256:x" }))?.kind, "changed");
});

test("other errors, and things that are not errors, are not host key stops", () => {
  assert.equal(hostKeyStop(error("SSH")), null);
  assert.equal(hostKeyStop(error("POSTGRES")), null);
  assert.equal(hostKeyStop(new Error("x")), null);
  assert.equal(hostKeyStop(null), null);
  assert.equal(hostKeyStop("SSH_HOST_UNKNOWN"), null);
});
