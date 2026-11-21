/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";

import type { PrivilegeMatrix, PrivilegeTarget, Role } from "../../bindings.ts";
import {
  buildRoleOperation,
  cellValue,
  emptyForm,
  formatValidUntil,
  formOf,
  formProblem,
  roleBadges,
  stageCell,
  stagedChanges,
  visibleGrantees,
  visibleRoles,
} from "./roles.ts";

function role(name: string, extra: Partial<Role> = {}): Role {
  return {
    name,
    canLogin: true,
    superuser: false,
    createDb: false,
    createRole: false,
    inherit: true,
    replication: false,
    bypassRls: false,
    connectionLimit: null,
    validUntil: null,
    memberOf: [],
    predefined: false,
    isCurrent: false,
    ...extra,
  };
}

test("a new role is created with its password, memberships and attributes", () => {
  const form = { ...emptyForm(), name: " report ", password: "pw", memberOf: ["readers"] };
  const op = buildRoleOperation(form, null);
  assert.equal(op.kind, "create");
  if (op.kind !== "create") return;
  assert.equal(op.name, "report");
  assert.equal(op.password, "pw");
  assert.deepEqual(op.memberOf, ["readers"]);
  assert.equal(op.attributes.canLogin, true);
  assert.equal(buildRoleOperation({ ...form, password: "" }, null).kind, "create");
  const noPassword = buildRoleOperation({ ...form, password: "" }, null);
  assert.equal(noPassword.kind === "create" && noPassword.password, null);
});

test("altering keeps the password unless one is typed or removal is asked for", () => {
  const original = role("bob", { memberOf: ["a"] });
  const form = formOf(original);
  const keep = buildRoleOperation(form, original);
  assert.equal(keep.kind === "alter" && keep.password.kind, "keep");
  assert.equal(keep.kind === "alter" && keep.newName, null);
  assert.deepEqual(keep.kind === "alter" && keep.previousMemberOf, ["a"]);

  const set = buildRoleOperation({ ...form, password: "new" }, original);
  assert.deepEqual(set.kind === "alter" && set.password, { kind: "set", value: "new" });
  const clear = buildRoleOperation({ ...form, clearPassword: true }, original);
  assert.equal(clear.kind === "alter" && clear.password.kind, "clear");

  const renamed = buildRoleOperation({ ...form, name: "robert" }, original);
  assert.equal(renamed.kind === "alter" && renamed.newName, "robert");
  assert.equal(renamed.kind === "alter" && renamed.name, "bob");
});

test("the preview version of a form never carries the real password", () => {
  const form = { ...emptyForm(), name: "x", password: "real secret" };
  const op = buildRoleOperation(form, null, { maskPassword: true });
  assert.equal(op.kind === "create" && op.password, "x");
  assert.ok(!JSON.stringify(op).includes("real secret"));
  const none = buildRoleOperation({ ...form, password: "" }, null, { maskPassword: true });
  assert.equal(none.kind === "create" && none.password, null);
});

test("what is wrong with a form", () => {
  const ok = { ...emptyForm(), name: "a" };
  assert.equal(formProblem(ok, null), null);
  assert.match(formProblem({ ...ok, name: "  " }, null) ?? "", /name/);
  const limit = (n: number | null) => ({
    ...ok,
    attributes: { ...ok.attributes, connectionLimit: n },
  });
  assert.match(formProblem(limit(-1), null) ?? "", /limit/);
  assert.match(formProblem(limit(1.5), null) ?? "", /limit/);
  assert.equal(formProblem(limit(0), null), null);
  const original = role("a");
  assert.match(
    formProblem({ ...ok, clearPassword: true, password: "p" }, original) ?? "",
    /not both/,
  );
});

test("badges say what matters; built-in roles are hidden until asked for", () => {
  assert.deepEqual(roleBadges(role("a", { superuser: true, createDb: true, inherit: false })), [
    "Superuser",
    "Login",
    "Create DB",
    "No inherit",
  ]);
  assert.deepEqual(roleBadges(role("g", { canLogin: false })), []);
  const roles = [
    role("pg_monitor", { predefined: true }),
    role("app", { memberOf: ["pg_monitor"] }),
  ];
  assert.deepEqual(
    visibleRoles(roles, false, "").map((r) => r.name),
    ["app"],
  );
  assert.deepEqual(
    visibleRoles(roles, true, "").map((r) => r.name),
    ["pg_monitor", "app"],
  );
  assert.deepEqual(
    visibleRoles(roles, true, "MONITOR").map((r) => r.name),
    ["pg_monitor", "app"],
  );
  assert.deepEqual(
    visibleRoles(roles, false, "ap").map((r) => r.name),
    ["app"],
  );
});

test("an expiry at midnight UTC is shown as a date", () => {
  assert.equal(formatValidUntil(null), "never");
  assert.equal(formatValidUntil("2031-02-03 00:00:00+00"), "2031-02-03");
  assert.equal(formatValidUntil("2031-02-03 10:30:00+00"), "2031-02-03 10:30:00+00");
});

const matrix: PrivilegeMatrix = {
  privileges: ["SELECT", "INSERT", "UPDATE"],
  owner: "angkor",
  rows: [
    { grantee: null, superuser: false, owner: false, granted: ["SELECT"], grantable: [] },
    {
      grantee: "angkor",
      superuser: true,
      owner: true,
      granted: ["SELECT", "INSERT", "UPDATE"],
      grantable: [],
    },
    { grantee: "bob", superuser: false, owner: false, granted: [], grantable: [] },
    { grantee: "eve", superuser: false, owner: false, granted: ["SELECT"], grantable: [] },
  ],
};
const target: PrivilegeTarget = { kind: "relation", schema: "public", name: "orders" };

test("staged cells show their value; putting a cell back removes the staging", () => {
  let staged = new Map<string, boolean>();
  staged = stageCell(matrix, staged, "bob", "SELECT", true);
  assert.equal(cellValue(matrix, staged, "bob", "SELECT"), true);
  assert.equal(cellValue(matrix, staged, "bob", "INSERT"), false);
  assert.equal(staged.size, 1);
  staged = stageCell(matrix, staged, "bob", "SELECT", false);
  assert.equal(staged.size, 0);
  // PUBLIC and a role of the same name don't collide.
  staged = stageCell(matrix, staged, null, "INSERT", true);
  assert.equal(cellValue(matrix, staged, null, "INSERT"), true);
  assert.equal(cellValue(matrix, staged, "PUBLIC", "INSERT"), false);
});

test("staged cells become grants and revokes, in matrix order", () => {
  let staged = new Map<string, boolean>();
  staged = stageCell(matrix, staged, "eve", "SELECT", false);
  staged = stageCell(matrix, staged, "bob", "UPDATE", true);
  staged = stageCell(matrix, staged, "bob", "SELECT", true);
  staged = stageCell(matrix, staged, null, "SELECT", true); // already held: nothing staged
  const changes = stagedChanges(matrix, staged, target);
  assert.deepEqual(
    changes.map((c) => [c.grantee, c.privilege, c.grant]),
    [
      ["bob", "SELECT", true],
      ["bob", "UPDATE", true],
      ["eve", "SELECT", false],
    ],
  );
  assert.ok(changes.every((c) => c.target === target));
});

test("only roles with access are drawn, unless they have a staged change; PUBLIC and the owner always", () => {
  const empty = new Map<string, boolean>();
  assert.deepEqual(
    visibleGrantees(matrix, empty, true, "").map((r) => r.grantee),
    [null, "angkor", "eve"],
  );
  const staged = stageCell(matrix, empty, "bob", "INSERT", true);
  assert.deepEqual(
    visibleGrantees(matrix, staged, true, "").map((r) => r.grantee),
    [null, "angkor", "bob", "eve"],
  );
  assert.deepEqual(
    visibleGrantees(matrix, empty, false, "").map((r) => r.grantee),
    [null, "angkor", "bob", "eve"],
  );
  assert.deepEqual(
    visibleGrantees(matrix, empty, false, "ev").map((r) => r.grantee),
    ["eve"],
  );
  assert.deepEqual(
    visibleGrantees(matrix, empty, false, "pub").map((r) => r.grantee),
    [null],
  );
});
