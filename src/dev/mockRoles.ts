/** Roles, privileges and default privileges for the in-browser mock. */
import type {
  DefaultPrivilege,
  PlannedStatement,
  PrivilegeChange,
  PrivilegeMatrix,
  PrivilegeTarget,
  Role,
  RoleOperation,
  StructurePreview,
} from "@/bindings";
import { appError } from "@/dev/mockSupport";

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const MASK = "'••••••••'";

function base(name: string, extra: Partial<Role> = {}): Role {
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

const initialRoles = (): Role[] => [
  base("angkor", {
    superuser: true,
    createDb: true,
    createRole: true,
    replication: true,
    bypassRls: true,
    isCurrent: true,
  }),
  base("app", { memberOf: ["readers"] }),
  base("readers", { canLogin: false }),
  base("readonly", { memberOf: ["pg_read_all_data"] }),
  base("reporting", {
    connectionLimit: 5,
    validUntil: "2031-02-03 00:00:00+00",
    memberOf: ["readers"],
  }),
  base("pg_read_all_data", { canLogin: false, predefined: true }),
  base("pg_monitor", { canLogin: false, predefined: true }),
];

let roles = initialRoles();

export const mockRoleList = (): Role[] => structuredClone(roles);

function plan(op: RoleOperation): { run: string; shown: string; destructive: boolean }[] {
  const out: { run: string; shown: string; destructive: boolean }[] = [];
  const one = (sql: string, destructive = false) => out.push({ run: sql, shown: sql, destructive });
  const words = (a: Extract<RoleOperation, { kind: "create" }>["attributes"], never: boolean) =>
    [
      a.canLogin ? "LOGIN" : "NOLOGIN",
      a.superuser ? "SUPERUSER" : "NOSUPERUSER",
      a.createDb ? "CREATEDB" : "NOCREATEDB",
      a.createRole ? "CREATEROLE" : "NOCREATEROLE",
      a.inherit ? "INHERIT" : "NOINHERIT",
      a.replication ? "REPLICATION" : "NOREPLICATION",
      a.bypassRls ? "BYPASSRLS" : "NOBYPASSRLS",
      `CONNECTION LIMIT ${a.connectionLimit ?? -1}`,
      ...(a.validUntil
        ? [`VALID UNTIL '${a.validUntil}'`]
        : never
          ? ["VALID UNTIL 'infinity'"]
          : []),
    ].join(" ");

  if (op.kind === "create") {
    if (op.name.trim() === "") throw appError("VALIDATION", "Give the role a name.");
    if (op.password === "") throw appError("VALIDATION", "The password is empty.");
    const head = `CREATE ROLE ${q(op.name)} WITH ${words(op.attributes, false)}`;
    out.push({
      run: `${head}${op.password ? " PASSWORD 'SCRAM-SHA-256$4096:…'" : ""};`,
      shown: `${head}${op.password ? ` PASSWORD ${MASK}` : ""};`,
      destructive: false,
    });
    for (const g of op.memberOf) one(`GRANT ${q(g)} TO ${q(op.name)};`);
  } else if (op.kind === "alter") {
    let current = q(op.name);
    if (op.newName && op.newName !== op.name) {
      one(`ALTER ROLE ${current} RENAME TO ${q(op.newName)};`);
      current = q(op.newName);
    }
    const head = `ALTER ROLE ${current} WITH ${words(op.attributes, true)}`;
    const tail =
      op.password.kind === "set"
        ? [" PASSWORD 'SCRAM-SHA-256$4096:…'", ` PASSWORD ${MASK}`]
        : op.password.kind === "clear"
          ? [" PASSWORD NULL", " PASSWORD NULL"]
          : ["", ""];
    out.push({ run: `${head}${tail[0]};`, shown: `${head}${tail[1]};`, destructive: false });
    for (const g of op.memberOf.filter((g) => !op.previousMemberOf.includes(g))) {
      one(`GRANT ${q(g)} TO ${current};`);
    }
    for (const g of op.previousMemberOf.filter((g) => !op.memberOf.includes(g))) {
      one(`REVOKE ${q(g)} FROM ${current};`, true);
    }
  } else {
    if (op.reassignTo === op.name) {
      throw appError("VALIDATION", "A role can't hand what it owns to itself.");
    }
    if (op.reassignTo) {
      one(`REASSIGN OWNED BY ${q(op.name)} TO ${q(op.reassignTo)};`, true);
      one(`DROP OWNED BY ${q(op.name)};`, true);
    }
    one(`DROP ROLE ${q(op.name)};`, true);
  }
  return out;
}

export function mockRolePreview(op: RoleOperation): StructurePreview {
  const statements: PlannedStatement[] = plan(op).map((s, i) => ({
    sql: s.shown,
    label: `step ${i + 1}`,
    change: 1,
    concurrent: false,
    destructive: s.destructive,
  }));
  return {
    statements,
    sql: `-- In one transaction: all or nothing.\n${statements.map((s) => s.sql).join("\n")}`,
  };
}

export function mockRoleApply(op: RoleOperation): number {
  const count = plan(op).length;
  if (op.kind === "create") {
    if (roles.some((r) => r.name === op.name)) {
      throw appError("POSTGRES", `role "${op.name}" already exists`, { pgCode: "42710" });
    }
    roles = [
      ...roles,
      base(op.name, {
        ...op.attributes,
        validUntil: op.attributes.validUntil
          ? `${op.attributes.validUntil.slice(0, 10)} 00:00:00+00`
          : null,
        memberOf: op.memberOf,
      }),
    ];
  } else if (op.kind === "alter") {
    const found = roles.find((r) => r.name === op.name);
    if (!found) throw appError("POSTGRES", `role "${op.name}" does not exist`, { pgCode: "42704" });
    const name = op.newName ?? op.name;
    roles = roles.map((r) =>
      r.name === op.name
        ? {
            ...r,
            ...op.attributes,
            name,
            validUntil: op.attributes.validUntil
              ? `${op.attributes.validUntil.slice(0, 10)} 00:00:00+00`
              : null,
            memberOf: op.memberOf,
          }
        : r,
    );
    if (name !== op.name) {
      roles = roles.map((r) => ({
        ...r,
        memberOf: r.memberOf.map((g) => (g === op.name ? name : g)),
      }));
    }
  } else {
    if (op.name === "app") {
      throw appError("POSTGRES", `role "app" cannot be dropped because some objects depend on it`, {
        pgCode: "2BP01",
        detail: "owner of table public.orders",
      });
    }
    roles = roles.filter((r) => r.name !== op.name);
  }
  return count;
}

// ---- privileges ------------------------------------------------------------------------------

const PRIVILEGES = {
  schema: ["USAGE", "CREATE"],
  relation: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
  sequence: ["USAGE", "SELECT", "UPDATE"],
} as const;

const key = (t: PrivilegeTarget) => `${t.kind}:${t.schema}.${t.name}`;
/** target → grantee ("" = PUBLIC) → what it holds */
let held = new Map<string, Map<string, Set<string>>>();

function initialFor(t: PrivilegeTarget): Map<string, Set<string>> {
  const all = new Set<string>(PRIVILEGES[t.kind]);
  const map = new Map<string, Set<string>>([["angkor", all]]);
  if (t.kind === "schema") map.set("", new Set(["USAGE"]));
  if (t.kind === "relation") map.set("readers", new Set(["SELECT"]));
  if (t.kind === "relation" && t.name === "orders")
    map.set("app", new Set(["SELECT", "INSERT", "UPDATE"]));
  return map;
}

function holdings(t: PrivilegeTarget) {
  let map = held.get(key(t));
  if (!map) {
    map = initialFor(t);
    held.set(key(t), map);
  }
  return map;
}

export function mockMatrix(t: PrivilegeTarget): PrivilegeMatrix {
  const columns = [...PRIVILEGES[t.kind]];
  const map = holdings(t);
  const row = (grantee: string | null, owner: boolean, superuser: boolean) => ({
    grantee,
    owner,
    superuser,
    granted: columns.filter((c) => map.get(grantee ?? "")?.has(c)),
    grantable: [],
  });
  return {
    privileges: columns,
    owner: "angkor",
    rows: [
      row(null, false, false),
      ...roles
        .filter((r) => !r.predefined)
        .map((r) => row(r.name, r.name === "angkor", r.superuser)),
    ],
  };
}

function privilegeStatements(changes: PrivilegeChange[]): PlannedStatement[] {
  const groups = new Map<string, { change: PrivilegeChange; list: string[] }>();
  for (const c of changes) {
    const allowed: readonly string[] = PRIVILEGES[c.target.kind];
    const wanted = c.privilege.toUpperCase();
    if (!allowed.includes(wanted)) {
      throw appError("VALIDATION", `${c.privilege} is not a privilege of a ${c.target.kind}.`);
    }
    const id = `${key(c.target)}|${c.grantee ?? ""}|${c.grant}`;
    const group = groups.get(id) ?? { change: c, list: [] };
    if (!group.list.includes(wanted)) group.list.push(wanted);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ change: c, list }) => {
    const object =
      c.target.kind === "schema"
        ? `SCHEMA ${q(c.target.name)}`
        : `${c.target.kind === "sequence" ? "SEQUENCE" : "TABLE"} ${q(c.target.schema)}.${q(c.target.name)}`;
    const who = c.grantee === null ? "PUBLIC" : q(c.grantee);
    return {
      sql: `${c.grant ? "GRANT" : "REVOKE"} ${list.join(", ")} ON ${object} ${c.grant ? "TO" : "FROM"} ${who};`,
      label: `${c.grant ? "grant" : "revoke"} ${list.join(", ")}`,
      change: 1,
      concurrent: false,
      destructive: false,
    };
  });
}

export function mockPrivilegePreview(changes: PrivilegeChange[]): StructurePreview {
  const statements = privilegeStatements(changes);
  return {
    statements,
    sql: `-- In one transaction: all or nothing.\n${statements.map((s) => s.sql).join("\n")}`,
  };
}

export function mockPrivilegeApply(changes: PrivilegeChange[]): number {
  const count = privilegeStatements(changes).length;
  for (const c of changes) {
    const set = holdings(c.target).get(c.grantee ?? "") ?? new Set<string>();
    if (c.grant) set.add(c.privilege.toUpperCase());
    else set.delete(c.privilege.toUpperCase());
    holdings(c.target).set(c.grantee ?? "", set);
  }
  return count;
}

export const mockDefaultPrivileges = (): DefaultPrivilege[] => [
  {
    role: "angkor",
    schema: "public",
    objectType: "tables",
    grantee: "readers",
    privileges: ["SELECT"],
  },
  { role: "angkor", schema: null, objectType: "sequences", grantee: null, privileges: ["USAGE"] },
  {
    role: "app",
    schema: "billing",
    objectType: "tables",
    grantee: "reporting",
    privileges: ["INSERT", "SELECT"],
  },
];

export function resetMockRoles() {
  roles = initialRoles();
  held = new Map();
}
