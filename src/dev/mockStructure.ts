/** A believable `table_structure` for the in-browser mock, built from the mock `describe_table`. */
import type {
  ConstraintInfo,
  IndexInfo,
  StructureColumn,
  TableStructure,
  TriggerInfo,
} from "@/bindings";
import { mockDescribeTable, mockRowEstimate } from "@/dev/mockSchema";

export function mockTableStructure(schema: string, table: string): TableStructure {
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
