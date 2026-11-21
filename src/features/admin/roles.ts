/** Roles and privileges: the form, the operation it becomes, and the staged matrix changes. */
import type {
  PrivilegeChange,
  PrivilegeMatrix,
  PrivilegeTarget,
  Role,
  RoleAttributes,
  RoleOperation,
} from "@/bindings";

/** What the role dialog edits. The password is only ever in this object, in memory. */
export interface RoleForm {
  name: string;
  password: string;
  /** Edit only: remove the password the role has. */
  clearPassword: boolean;
  attributes: RoleAttributes;
  memberOf: string[];
}

export const NEW_ATTRIBUTES: RoleAttributes = {
  canLogin: true,
  superuser: false,
  createDb: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
  connectionLimit: null,
  validUntil: null,
};

export const emptyForm = (): RoleForm => ({
  name: "",
  password: "",
  clearPassword: false,
  attributes: { ...NEW_ATTRIBUTES },
  memberOf: [],
});

export function formOf(role: Role): RoleForm {
  return {
    name: role.name,
    password: "",
    clearPassword: false,
    attributes: {
      canLogin: role.canLogin,
      superuser: role.superuser,
      createDb: role.createDb,
      createRole: role.createRole,
      inherit: role.inherit,
      replication: role.replication,
      bypassRls: role.bypassRls,
      connectionLimit: role.connectionLimit,
      validUntil: role.validUntil,
    },
    memberOf: [...role.memberOf],
  };
}

/** What is wrong with the form, in words; `null` when it can be sent. */
export function formProblem(form: RoleForm, original: Role | null): string | null {
  if (form.name.trim() === "") return "Give the role a name.";
  const limit = form.attributes.connectionLimit;
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    return "The connection limit is a whole number, or empty for no limit.";
  }
  if (original && form.clearPassword && form.password !== "") {
    return "Either set a new password or remove the password, not both.";
  }
  return null;
}

/** `password` stands in for the real one when `maskPassword` is set (the preview only needs to know there is one). */
export function buildRoleOperation(
  form: RoleForm,
  original: Role | null,
  options: { maskPassword?: boolean } = {},
): RoleOperation {
  const secret = options.maskPassword && form.password !== "" ? "x" : form.password;
  const attributes: RoleAttributes = {
    ...form.attributes,
    validUntil: form.attributes.validUntil?.trim() || null,
  };
  if (!original) {
    return {
      kind: "create",
      name: form.name.trim(),
      attributes,
      password: secret === "" ? null : secret,
      memberOf: form.memberOf,
    };
  }
  const name = form.name.trim();
  return {
    kind: "alter",
    name: original.name,
    newName: name === original.name ? null : name,
    attributes,
    password:
      secret !== ""
        ? { kind: "set", value: secret }
        : form.clearPassword
          ? { kind: "clear" }
          : { kind: "keep" },
    memberOf: form.memberOf,
    previousMemberOf: original.memberOf,
  };
}

/** The badges for what a role may do, most important first. */
export function roleBadges(role: Role): string[] {
  const badges: string[] = [];
  if (role.superuser) badges.push("Superuser");
  if (role.canLogin) badges.push("Login");
  if (role.createDb) badges.push("Create DB");
  if (role.createRole) badges.push("Create role");
  if (role.replication) badges.push("Replication");
  if (role.bypassRls) badges.push("Bypass RLS");
  if (!role.inherit) badges.push("No inherit");
  return badges;
}

/** Roles to draw: predefined ones only when asked for, the filter on the name and memberships. */
export function visibleRoles(roles: readonly Role[], showBuiltIn: boolean, text: string): Role[] {
  const needle = text.trim().toLowerCase();
  return roles.filter(
    (r) =>
      (showBuiltIn || !r.predefined) &&
      (needle === "" ||
        r.name.toLowerCase().includes(needle) ||
        r.memberOf.some((g) => g.toLowerCase().includes(needle))),
  );
}

/** `2031-02-03 00:00:00+00` → `2031-02-03`; the time is shown only when it isn't midnight UTC. */
export function formatValidUntil(value: string | null): string {
  if (!value) return "never";
  const match = /^(\d{4}-\d{2}-\d{2}) 00:00:00(\+00(:00)?)?$/.exec(value);
  return match?.[1] ?? value;
}

// ---- the privilege matrix --------------------------------------------------------------------

/** One checkbox of the matrix. `grantee` is `null` for PUBLIC. */
export const cellKey = (grantee: string | null, privilege: string) =>
  `${grantee === null ? "\u0000PUBLIC" : `r:${grantee}`}\u0001${privilege}`;

/** What is held now, from the matrix. */
export function heldNow(matrix: PrivilegeMatrix, grantee: string | null, privilege: string) {
  return matrix.rows.find((r) => r.grantee === grantee)?.granted.includes(privilege) ?? false;
}

/** The value of a cell: what is staged, or else what is held. */
export function cellValue(
  matrix: PrivilegeMatrix,
  staged: ReadonlyMap<string, boolean>,
  grantee: string | null,
  privilege: string,
): boolean {
  return staged.get(cellKey(grantee, privilege)) ?? heldNow(matrix, grantee, privilege);
}

/** Set a cell; staging what is already held takes the staging away. */
export function stageCell(
  matrix: PrivilegeMatrix,
  staged: ReadonlyMap<string, boolean>,
  grantee: string | null,
  privilege: string,
  value: boolean,
): Map<string, boolean> {
  const next = new Map(staged);
  const key = cellKey(grantee, privilege);
  if (heldNow(matrix, grantee, privilege) === value) next.delete(key);
  else next.set(key, value);
  return next;
}

/** The GRANTs and REVOKEs the staged cells come to, in the order of the matrix. */
export function stagedChanges(
  matrix: PrivilegeMatrix,
  staged: ReadonlyMap<string, boolean>,
  target: PrivilegeTarget,
): PrivilegeChange[] {
  const out: PrivilegeChange[] = [];
  for (const row of matrix.rows) {
    for (const privilege of matrix.privileges) {
      const value = staged.get(cellKey(row.grantee, privilege));
      if (value === undefined || value === heldNow(matrix, row.grantee, privilege)) continue;
      out.push({ target, grantee: row.grantee, privilege, grant: value });
    }
  }
  return out;
}

/** The rows to draw: PUBLIC and the owner always, then whoever holds something or has a change. */
export function visibleGrantees(
  matrix: PrivilegeMatrix,
  staged: ReadonlyMap<string, boolean>,
  onlyWithAccess: boolean,
  text: string,
) {
  const needle = text.trim().toLowerCase();
  return matrix.rows.filter((row) => {
    if (needle !== "" && !(row.grantee ?? "public").toLowerCase().includes(needle)) return false;
    if (!onlyWithAccess || row.grantee === null || row.owner) return true;
    return (
      row.granted.length > 0 || matrix.privileges.some((p) => staged.has(cellKey(row.grantee, p)))
    );
  });
}

export const targetKey = (t: PrivilegeTarget) => `${t.kind}:${t.schema}.${t.name}`;
