/** A believable `table_structure` for the in-browser mock, built from the mock `describe_table`. */
import type {
  ConstraintInfo,
  IndexInfo,
  PlannedStatement,
  StructureApplyResult,
  StructureChange,
  StructureColumn,
  StructurePreview,
  TableStructure,
  TriggerInfo,
} from "@/bindings";
import { mockDescribeTable, mockRowEstimate } from "@/dev/mockSchema";

export function mockTableStructure(schema: string, table: string): TableStructure {
  return withApplied(buildStructure(schema, table));
}

function buildStructure(schema: string, table: string): TableStructure {
  const d = mockDescribeTable(schema, table);
  const isView = d.kind === "view" || d.kind === "materializedView";
  const qualified = `${schema}.${table}`;

  const columns: StructureColumn[] = d.columns.map((c) => ({
    position: c.position,
    name: c.name,
    typeName: c.typeName,
    nullable: c.nullable,
    defaultValue: c.defaultValue,
    identity: c.identity,
    generated: c.generated ? "stored" : null,
    collation: null,
    comment: c.comment,
    isPrimaryKey: c.isPrimaryKey,
    foreignKeys: c.foreignKeys,
  }));

  const keyColumns = d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
  const indexes: IndexInfo[] = [];
  const constraints: ConstraintInfo[] = [];
  if (!isView && keyColumns.length > 0) {
    indexes.push({
      name: `${table}_pkey`,
      definition: `CREATE UNIQUE INDEX ${table}_pkey ON ${qualified} USING btree (${keyColumns.join(", ")})`,
      columns: keyColumns,
      method: "btree",
      unique: true,
      primary: true,
      valid: true,
      partial: false,
      sizeBytes: 16384,
      constraint: `${table}_pkey`,
      comment: null,
    });
    constraints.push({
      name: `${table}_pkey`,
      kind: "primaryKey",
      definition: `PRIMARY KEY (${keyColumns.join(", ")})`,
      columns: keyColumns,
      references: null,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      comment: null,
    });
  }
  const foreignKeys = d.columns.flatMap((c) => c.foreignKeys.map((fk) => ({ column: c.name, fk })));
  for (const { column, fk } of foreignKeys) {
    indexes.push({
      name: `${table}_${column}_idx`,
      definition: `CREATE INDEX ${table}_${column}_idx ON ${qualified} USING btree (${column})`,
      columns: [column],
      method: "btree",
      unique: false,
      primary: false,
      valid: true,
      partial: false,
      sizeBytes: 40960,
      constraint: null,
      comment: null,
    });
    constraints.push({
      name: fk.constraint,
      kind: "foreignKey",
      definition: `FOREIGN KEY (${column}) REFERENCES ${fk.schema}.${fk.table}(${fk.column})`,
      columns: [column],
      references: `${fk.schema}.${fk.table}`,
      deferrable: false,
      initiallyDeferred: false,
      validated: true,
      comment: null,
    });
  }

  const triggers: TriggerInfo[] =
    qualified === "public.users"
      ? [
          {
            name: "users_touch_updated_at",
            timing: "BEFORE",
            events: ["UPDATE"],
            perRow: true,
            function: "public.touch_updated_at",
            state: "enabled",
            definition:
              "CREATE TRIGGER users_touch_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at()",
          },
        ]
      : [];

  const lines = columns.map(
    (c) =>
      `    ${c.name} ${c.typeName}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ""}${c.nullable ? "" : " NOT NULL"}`,
  );
  if (keyColumns.length > 0) {
    lines.push(`    CONSTRAINT ${table}_pkey PRIMARY KEY (${keyColumns.join(", ")})`);
  }
  const create = isView
    ? `CREATE ${d.kind === "view" ? "VIEW" : "MATERIALIZED VIEW"} ${qualified} AS\nSELECT ${columns.map((c) => c.name).join(",\n    ")}\n   FROM ${schema}.some_table;`
    : `CREATE TABLE ${qualified} (\n${lines.join(",\n")}\n);`;
  const parts = [create];
  const ownIndexes = indexes.filter((i) => !i.primary);
  if (ownIndexes.length > 0) parts.push(ownIndexes.map((i) => `${i.definition};`).join("\n"));
  const fkLines = constraints
    .filter((c) => c.kind === "foreignKey")
    .map((c) => `ALTER TABLE ${qualified}\n    ADD CONSTRAINT ${c.name} ${c.definition};`);
  if (fkLines.length > 0) parts.push(fkLines.join("\n"));
  if (triggers[0]) parts.push(`${triggers[0].definition};`);
  if (d.comment) parts.push(`COMMENT ON TABLE ${qualified} IS '${d.comment.replace(/'/g, "''")}';`);

  const needs: string[] = [];
  if (schema !== "public") needs.push(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
  if (columns.some((c) => c.typeName === "citext")) {
    needs.push("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;");
  }
  if (columns.some((c) => c.typeName === "user_status")) {
    needs.push("CREATE TYPE public.user_status AS ENUM ('active', 'invited', 'suspended');");
  }
  if (triggers[0]) {
    needs.push(
      "CREATE OR REPLACE FUNCTION public.touch_updated_at()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  NEW.updated_at := now();\n  RETURN NEW;\nEND;\n$function$;",
    );
  }

  const rows = mockRowEstimate(schema, table);
  return {
    schema,
    name: table,
    kind: d.kind,
    info: {
      owner: "angkor",
      comment: d.comment,
      persistence: "permanent",
      rowEstimate: d.kind === "view" ? null : rows,
      totalBytes: isView ? 0 : 1_572_864,
      tableBytes: isView ? 0 : 1_146_880,
      indexBytes: isView ? 0 : 425_984,
      toastBytes: isView ? 0 : 8192,
      tablespace: null,
      accessMethod: isView ? null : "heap",
      partitionKey: null,
      partitionBound: null,
      parents: [],
      partitions: [],
      rowSecurity: false,
      options: [],
      populated: d.kind === "materializedView" ? true : null,
    },
    columns,
    indexes,
    constraints,
    triggers,
    ddl: `${parts.join("\n\n")}\n`,
    prerequisites: needs.length > 0 ? `${needs.join("\n\n")}\n` : "",
  };
}

// ---- Changing the structure (the mock keeps what was applied and replays it) ---------------------

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Roughly what the Rust planner writes, so the preview in the browser looks right. */
export function mockPlan(
  schema: string,
  table: string,
  changes: StructureChange[],
): PlannedStatement[] {
  const target = `${q(schema)}.${q(table)}`;
  const out: PlannedStatement[] = [];
  changes.forEach((change, i) => {
    const push = (label: string, sql: string, concurrent = false, destructive = false) =>
      out.push({ sql, label, change: i + 1, concurrent, destructive });
    const alterTable = (label: string, action: string, destructive = false) =>
      push(label, `ALTER TABLE ${target} ${action};`, false, destructive);
    switch (change.kind) {
      case "addColumn":
        alterTable(
          `add column ${change.name}`,
          `ADD COLUMN ${q(change.name)} ${change.typeName}${change.defaultValue ? ` DEFAULT ${change.defaultValue}` : ""}${change.nullable ? "" : " NOT NULL"}`,
        );
        if (change.comment) {
          push(
            `comment on column ${change.name}`,
            `COMMENT ON COLUMN ${target}.${q(change.name)} IS '${change.comment.replace(/'/g, "''")}';`,
          );
        }
        break;
      case "alterColumn": {
        const col = q(change.column);
        if (change.typeName) {
          alterTable(
            `change type of column ${change.column}`,
            `ALTER COLUMN ${col} TYPE ${change.typeName}${change.using ? ` USING ${change.using}` : ""}`,
          );
        }
        if (change.defaultValue) {
          alterTable(
            `default of column ${change.column}`,
            change.defaultValue.kind === "set"
              ? `ALTER COLUMN ${col} SET DEFAULT ${change.defaultValue.expression}`
              : `ALTER COLUMN ${col} DROP DEFAULT`,
          );
        }
        if (change.nullable !== null) {
          alterTable(
            `nullability of column ${change.column}`,
            `ALTER COLUMN ${col} ${change.nullable ? "DROP" : "SET"} NOT NULL`,
          );
        }
        if (change.newName) {
          alterTable(
            `rename column ${change.column}`,
            `RENAME COLUMN ${col} TO ${q(change.newName)}`,
          );
        }
        if (change.comment) {
          push(
            `comment on column ${change.newName ?? change.column}`,
            `COMMENT ON COLUMN ${target}.${q(change.newName ?? change.column)} IS ${change.comment.kind === "set" ? `'${change.comment.text.replace(/'/g, "''")}'` : "NULL"};`,
          );
        }
        break;
      }
      case "dropColumn":
        alterTable(`drop column ${change.column}`, `DROP COLUMN ${q(change.column)}`, true);
        break;
      case "createIndex": {
        const cols = change.columns
          .map((c) => `${c.isExpression ? `(${c.text})` : q(c.text)}${c.descending ? " DESC" : ""}`)
          .join(", ");
        push(
          change.name ? `create index ${change.name}` : "create index",
          `CREATE ${change.unique ? "UNIQUE " : ""}INDEX ${change.concurrently ? "CONCURRENTLY " : ""}${change.name ? `${q(change.name)} ` : ""}ON ${target} USING ${change.method} (${cols})${change.whereClause ? ` WHERE ${change.whereClause}` : ""};`,
          change.concurrently,
        );
        break;
      }
      case "dropIndex":
        push(
          `drop index ${change.name}`,
          `DROP INDEX ${change.concurrently ? "CONCURRENTLY " : ""}${q(schema)}.${q(change.name)};`,
          change.concurrently,
          true,
        );
        break;
      case "addPrimaryKey":
        alterTable(
          "add primary key",
          `ADD${change.name ? ` CONSTRAINT ${q(change.name)}` : ""} PRIMARY KEY (${change.columns.map(q).join(", ")})`,
        );
        break;
      case "addUnique":
        alterTable(
          "add unique constraint",
          `ADD${change.name ? ` CONSTRAINT ${q(change.name)}` : ""} UNIQUE (${change.columns.map(q).join(", ")})`,
        );
        break;
      case "addCheck":
        alterTable(
          "add check constraint",
          `ADD${change.name ? ` CONSTRAINT ${q(change.name)}` : ""} CHECK (${change.expression})${change.notValid ? " NOT VALID" : ""}`,
        );
        break;
      case "addForeignKey":
        alterTable(
          "add foreign key",
          `ADD${change.name ? ` CONSTRAINT ${q(change.name)}` : ""} FOREIGN KEY (${change.columns.map(q).join(", ")}) REFERENCES ${q(change.refSchema)}.${q(change.refTable)} (${change.refColumns.map(q).join(", ")})${change.onDelete === "noAction" ? "" : ` ON DELETE ${change.onDelete}`}${change.notValid ? " NOT VALID" : ""}`,
        );
        break;
      case "dropConstraint":
        alterTable(`drop constraint ${change.name}`, `DROP CONSTRAINT ${q(change.name)}`, true);
        break;
    }
  });
  return out;
}

export function mockPreview(
  schema: string,
  table: string,
  changes: StructureChange[],
): StructurePreview {
  const statements = mockPlan(schema, table, changes);
  const inside = statements.filter((s) => !s.concurrent).map((s) => s.sql);
  const outside = statements.filter((s) => s.concurrent).map((s) => s.sql);
  const parts = [];
  if (inside.length > 0) parts.push(`-- In one transaction: all or nothing.\n${inside.join("\n")}`);
  if (outside.length > 0) {
    parts.push(
      `-- CONCURRENTLY can't run inside a transaction. These run on their own, one after\n-- the other, once the transaction above is saved. If one fails, the rest is still saved.\n${outside.join("\n")}`,
    );
  }
  return { statements, sql: parts.join("\n\n") };
}

/** What was applied to each mock table, replayed over the original structure. */
const applied: Record<string, StructureChange[]> = {};

export function mockApply(
  schema: string,
  table: string,
  changes: StructureChange[],
): StructureApplyResult {
  const key = `${schema}.${table}`;
  applied[key] = [...(applied[key] ?? []), ...changes];
  return { statements: mockPlan(schema, table, changes).length, failedConcurrent: null };
}

/** The structure with the applied changes on it. */
function withApplied(base: TableStructure): TableStructure {
  const changes = applied[`${base.schema}.${base.name}`] ?? [];
  if (changes.length === 0) return base;
  let columns = [...base.columns];
  let indexes = [...base.indexes];
  let constraints = [...base.constraints];
  for (const change of changes) {
    switch (change.kind) {
      case "addColumn":
        columns.push({
          position: columns.length + 1,
          name: change.name,
          typeName: change.typeName,
          nullable: change.nullable,
          defaultValue: change.defaultValue,
          identity: null,
          generated: null,
          collation: null,
          comment: change.comment,
          isPrimaryKey: false,
          foreignKeys: [],
        });
        break;
      case "alterColumn":
        columns = columns.map((c) =>
          c.name !== change.column
            ? c
            : {
                ...c,
                name: change.newName ?? c.name,
                typeName: change.typeName ?? c.typeName,
                nullable: change.nullable ?? c.nullable,
                defaultValue:
                  change.defaultValue === null
                    ? c.defaultValue
                    : change.defaultValue.kind === "set"
                      ? change.defaultValue.expression
                      : null,
                comment:
                  change.comment === null
                    ? c.comment
                    : change.comment.kind === "set"
                      ? change.comment.text
                      : null,
              },
        );
        break;
      case "dropColumn":
        columns = columns.filter((c) => c.name !== change.column);
        break;
      case "createIndex":
        indexes.push({
          name: change.name ?? `${base.name}_${change.columns.map((c) => c.text).join("_")}_idx`,
          definition: `CREATE ${change.unique ? "UNIQUE " : ""}INDEX ON ${base.schema}.${base.name} USING ${change.method} (${change.columns.map((c) => c.text).join(", ")})`,
          columns: change.columns.map((c) => c.text),
          method: change.method,
          unique: change.unique,
          primary: false,
          valid: true,
          partial: change.whereClause !== null,
          sizeBytes: 8192,
          constraint: null,
          comment: null,
        });
        break;
      case "dropIndex":
        indexes = indexes.filter((i) => i.name !== change.name);
        break;
      case "dropConstraint":
        constraints = constraints.filter((c) => c.name !== change.name);
        break;
      case "addUnique":
      case "addPrimaryKey":
        constraints.push({
          name: change.name ?? `${base.name}_${change.columns.join("_")}_key`,
          kind: change.kind === "addUnique" ? "unique" : "primaryKey",
          definition: `${change.kind === "addUnique" ? "UNIQUE" : "PRIMARY KEY"} (${change.columns.join(", ")})`,
          columns: change.columns,
          references: null,
          deferrable: false,
          initiallyDeferred: false,
          validated: true,
          comment: null,
        });
        break;
      case "addCheck":
        constraints.push({
          name: change.name ?? `${base.name}_check`,
          kind: "check",
          definition: `CHECK (${change.expression})`,
          columns: [],
          references: null,
          deferrable: false,
          initiallyDeferred: false,
          validated: !change.notValid,
          comment: null,
        });
        break;
      case "addForeignKey":
        constraints.push({
          name: change.name ?? `${base.name}_${change.columns.join("_")}_fkey`,
          kind: "foreignKey",
          definition: `FOREIGN KEY (${change.columns.join(", ")}) REFERENCES ${change.refSchema}.${change.refTable}(${change.refColumns.join(", ")})`,
          columns: change.columns,
          references: `${change.refSchema}.${change.refTable}`,
          deferrable: false,
          initiallyDeferred: false,
          validated: !change.notValid,
          comment: null,
        });
        break;
    }
  }
  columns = columns.map((c, i) => ({ ...c, position: i + 1 }));
  return { ...base, columns, indexes, constraints };
}
