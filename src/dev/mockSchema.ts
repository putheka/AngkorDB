/** Fake schema browsing for the in-browser mock backend: a small copy of `dev/seed.sql`. */
import type {
  ColumnInfo,
  ColumnIdentity,
  DatabaseInfo,
  DbObject,
  ObjectKind,
  RowIdentity,
  SchemaInfo,
  TableDescription,
} from "@/bindings";
import { appError, type Handler } from "@/dev/mockSupport";

let nextOid = 16400;

function object(
  schema: string,
  name: string,
  kind: ObjectKind,
  rowEstimate: number | null = null,
  detail: string | null = null,
): DbObject {
  return { oid: nextOid++, schema, name, kind, rowEstimate, detail };
}

const OBJECTS: Record<string, DbObject[]> = {
  public: [
    object("public", "user_status", "enumType"),
    object("public", "greet", "function", null, "(p_name text DEFAULT 'world'::text) → text"),
    object("public", "order_total", "function", null, "(p_order_id bigint) → numeric"),
    object("public", "touch_updated_at", "function", null, "() → trigger"),
    object("public", "orders_id_seq", "sequence"),
    object("public", "app_settings", "table", 3),
    object("public", "event_log", "table", 4),
    object("public", "metrics_big", "table", 1_000_000),
    object("public", "order_items", "table", 3000),
    object("public", "orders", "table", 1000),
    object("public", "short_codes", "table", 3),
    object("public", "users", "table", 205),
    object("public", "wide_table", "table", 500),
    object("public", "user_order_totals", "view"),
  ],
  billing: [
    object("billing", "monthly_revenue", "materializedView", 4),
    object("billing", "invoice_no_seq", "sequence"),
    object("billing", "invoices", "table", 750),
  ],
};

/** Browser dev only: a schema with 1,200 tables and a few other objects, to try the sidebar at scale. */
const stress: DbObject[] = [
  ...Array.from({ length: 1200 }, (_, i) =>
    object("stress", `table_${String(i + 1).padStart(4, "0")}`, "table", (i + 1) * 37),
  ),
  ...Array.from({ length: 40 }, (_, i) => object("stress", `report_view_${i + 1}`, "view")),
];
OBJECTS["stress"] = stress;

interface ColumnSpec {
  type: string;
  base?: string;
  pk?: boolean;
  notNull?: boolean;
  default?: string;
  identity?: ColumnIdentity;
  fk?: [table: string, column: string];
}

interface TableSpec {
  kind: ObjectKind;
  columns: Record<string, ColumnSpec>;
  identity: RowIdentity;
  comment?: string;
}

const TABLES: Record<string, TableSpec> = {
  "public.users": {
    kind: "table",
    comment: "Every tricky Postgres type in one place",
    identity: { kind: "primaryKey", columns: ["id"] },
    columns: {
      id: { type: "bigint", pk: true, notNull: true, identity: "always" },
      email: { type: "citext", notNull: true },
      name: { type: "character varying(100)", base: "character varying" },
      status: { type: "user_status", notNull: true, default: "'active'::user_status" },
      is_admin: { type: "boolean", notNull: true, default: "false" },
      balance: { type: "numeric(20,6)", base: "numeric", notNull: true, default: "0" },
      big_counter: { type: "bigint" },
      tags: { type: "text[]" },
      profile: { type: "jsonb" },
      created_at: { type: "timestamp with time zone", notNull: true, default: "now()" },
    },
  },
  "public.orders": {
    kind: "table",
    identity: { kind: "primaryKey", columns: ["id"] },
    columns: {
      id: {
        type: "bigint",
        pk: true,
        notNull: true,
        default: "nextval('orders_id_seq'::regclass)",
      },
      user_id: { type: "bigint", notNull: true, fk: ["users", "id"] },
      status: { type: "text", notNull: true, default: "'pending'::text" },
      total: { type: "numeric(12,2)", base: "numeric", notNull: true, default: "0" },
    },
  },
  "public.order_items": {
    kind: "table",
    identity: { kind: "primaryKey", columns: ["order_id", "line_no"] },
    columns: {
      order_id: { type: "bigint", pk: true, notNull: true, fk: ["orders", "id"] },
      line_no: { type: "smallint", pk: true, notNull: true },
      product_sku: { type: "text", notNull: true },
      qty: { type: "integer", notNull: true },
    },
  },
  "public.event_log": {
    kind: "table",
    identity: { kind: "ctid" },
    columns: {
      occurred_at: { type: "timestamp with time zone", notNull: true },
      level: { type: "text", notNull: true },
      message: { type: "text" },
      payload: { type: "jsonb" },
    },
  },
  "public.metrics_big": {
    kind: "table",
    identity: { kind: "primaryKey", columns: ["id"] },
    columns: {
      id: { type: "bigint", pk: true, notNull: true, identity: "always" },
      recorded_at: { type: "timestamp with time zone", notNull: true },
      sensor: { type: "text", notNull: true },
      value: { type: "double precision" },
      meta: { type: "jsonb" },
    },
  },
  "public.wide_table": {
    kind: "table",
    comment: "100 columns, to check the grid with a wide table",
    identity: { kind: "primaryKey", columns: ["id"] },
    columns: {
      id: { type: "bigint", pk: true, notNull: true },
      ...Object.fromEntries(
        Array.from({ length: 99 }, (_, i): [string, ColumnSpec] => {
          const n = String(i + 1).padStart(2, "0");
          const kinds: ColumnSpec[] = [
            { type: "text" },
            { type: "integer" },
            { type: "numeric(12,2)", base: "numeric" },
            { type: "boolean" },
            { type: "timestamp with time zone" },
          ];
          return [`col_${n}`, kinds[i % kinds.length] ?? { type: "text" }];
        }),
      ),
    },
  },
  "public.user_order_totals": {
    kind: "view",
    identity: { kind: "readOnly", reason: "Views can't be edited." },
    columns: {
      user_id: { type: "bigint" },
      email: { type: "citext" },
      orders: { type: "bigint" },
      total_spent: { type: "numeric" },
    },
  },
};

/** Tables without a hand-written spec still open: an id and a name. */
const FALLBACK: TableSpec = {
  kind: "table",
  identity: { kind: "primaryKey", columns: ["id"] },
  columns: { id: { type: "bigint", pk: true, notNull: true }, name: { type: "text" } },
};

/** The OIDs Postgres really uses, so the grid aligns and draws mock columns like real ones. */
const TYPE_OIDS: Record<string, number> = {
  bigint: 20,
  smallint: 21,
  integer: 23,
  numeric: 1700,
  "double precision": 701,
  boolean: 16,
  json: 114,
  jsonb: 3802,
  text: 25,
  "timestamp with time zone": 1184,
};

function buildColumns(schema: string, spec: TableSpec): ColumnInfo[] {
  return Object.entries(spec.columns).map(([name, c], index) => ({
    name,
    position: index + 1,
    typeName: c.type,
    baseType: c.base ?? c.type,
    typeOid: TYPE_OIDS[c.base ?? c.type] ?? 25,
    nullable: !c.notNull,
    defaultValue: c.default ?? null,
    identity: c.identity ?? null,
    generated: false,
    isPrimaryKey: c.pk ?? false,
    comment: null,
    foreignKeys: c.fk
      ? [{ constraint: `fk_${name}`, schema, table: c.fk[0], column: c.fk[1] }]
      : [],
  }));
}

/** `describe_table` without the connection check; the mock rows are built from it too. */
export function mockDescribeTable(schema: string, table: string): TableDescription {
  const listed = OBJECTS[schema]?.find(
    (o) => o.name === table && ["table", "view", "materializedView"].includes(o.kind),
  );
  if (!listed) throw appError("NOT_FOUND", `table or view ${schema}.${table} not found`);

  const spec = TABLES[`${schema}.${table}`] ?? { ...FALLBACK, kind: listed.kind };
  return {
    schema,
    name: table,
    kind: spec.kind,
    comment: spec.comment ?? null,
    columns: buildColumns(schema, spec),
    identity:
      listed.kind === "materializedView"
        ? { kind: "readOnly", reason: "Materialized views can't be edited." }
        : spec.identity,
  };
}

/** The `rowEstimate` the sidebar shows for a table, if it is listed. */
export function mockRowEstimate(schema: string, table: string): number | null {
  return OBJECTS[schema]?.find((o) => o.name === table)?.rowEstimate ?? null;
}

/** Handlers for the schema commands. `requireOpen` throws when the connection isn't open. */
export function createSchemaHandlers(requireOpen: (id: string) => void): Record<string, Handler> {
  const currentDatabase = new Map<string, string>();
  const databaseOf = (id: string) => currentDatabase.get(id) ?? "angkordb_dev";

  return {
    list_databases: (args) => {
      const id = String(args["connectionId"]);
      requireOpen(id);
      const current = databaseOf(id);
      return ["angkordb_dev", "postgres"].map((name): DatabaseInfo => ({
        name,
        isCurrent: name === current,
      }));
    },

    switch_database: (args) => {
      const id = String(args["connectionId"]);
      requireOpen(id);
      const database = String(args["database"]);
      if (!["angkordb_dev", "postgres"].includes(database)) {
        throw appError("POSTGRES", `database "${database}" does not exist`, { pgCode: "3D000" });
      }
      currentDatabase.set(id, database);
      return { serverVersion: "16.4", latencyMs: 9 };
    },

    list_schemas: (args) => {
      requireOpen(String(args["connectionId"]));
      const user: SchemaInfo[] = Object.keys(OBJECTS).map((name) => ({
        name,
        owner: "angkor",
        isSystem: false,
      }));
      const system: SchemaInfo[] = ["information_schema", "pg_catalog"].map((name) => ({
        name,
        owner: "angkor",
        isSystem: true,
      }));
      return args["includeSystem"] === true ? [...user, ...system] : user;
    },

    list_objects: (args) => {
      requireOpen(String(args["connectionId"]));
      return structuredClone(OBJECTS[String(args["schema"])] ?? []);
    },

    describe_table: (args): TableDescription => {
      requireOpen(String(args["connectionId"]));
      return mockDescribeTable(String(args["schema"]), String(args["table"]));
    },
  };
}
