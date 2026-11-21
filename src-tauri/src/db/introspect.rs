//! Read the structure of a database from `pg_catalog` (faster than `information_schema`, and it
//! knows materialized views). Every value from the user is a bound parameter.

use tokio_postgres::Client;

use crate::error::{AppError, AppResult};
use crate::models::schema::{
    ColumnIdentity, ColumnInfo, CompletionColumn, CompletionFunction, CompletionSchema,
    CompletionTable, DatabaseInfo, DbObject, ForeignKeyRef, IncomingForeignKey, ObjectKind,
    RowIdentity, SchemaInfo, TableDescription,
};

/// Databases this user can connect to, without templates.
pub async fn list_databases(client: &Client) -> AppResult<Vec<DatabaseInfo>> {
    let rows = client
        .query(
            "SELECT datname::text, datname = current_database()
               FROM pg_database
              WHERE datallowconn AND NOT datistemplate
                AND has_database_privilege(datname, 'CONNECT')
              ORDER BY datname",
            &[],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| DatabaseInfo {
            name: row.get(0),
            is_current: row.get(1),
        })
        .collect())
}

/// Schemas, `public` first. System schemas (`pg_*`, `information_schema`) only when asked for.
pub async fn list_schemas(client: &Client, include_system: bool) -> AppResult<Vec<SchemaInfo>> {
    let rows = client
        .query(
            "SELECT nspname::text, pg_get_userbyid(nspowner)::text,
                    (nspname ~ '^pg_' OR nspname = 'information_schema')
               FROM pg_namespace
              WHERE $1::bool OR NOT (nspname ~ '^pg_' OR nspname = 'information_schema')
              ORDER BY nspname <> 'public', nspname",
            &[&include_system],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| SchemaInfo {
            name: row.get(0),
            owner: row.get(1),
            is_system: row.get(2),
        })
        .collect())
}

/// Everything the sidebar shows for one schema, sorted by kind then name.
///
/// Left out on purpose: functions and types that belong to an extension (citext alone adds
/// dozens), and the sequences behind identity columns (an implementation detail).
pub async fn list_objects(client: &Client, schema: &str) -> AppResult<Vec<DbObject>> {
    const SQL: &str = "
        SELECT c.oid, c.relname::text AS name,
               CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitionedTable'
                    WHEN 'f' THEN 'foreignTable' WHEN 'v' THEN 'view'
                    WHEN 'm' THEN 'materializedView' ELSE 'sequence' END AS kind,
               CASE WHEN c.relkind IN ('r', 'p', 'm', 'f') AND c.reltuples >= 0
                    THEN c.reltuples::float8 END AS row_estimate,
               NULL::text AS detail
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
           AND NOT (c.relkind = 'S' AND EXISTS (
                 SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i'))
        UNION ALL
        SELECT p.oid, p.proname::text,
               CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
               NULL::float8,
               '(' || pg_get_function_arguments(p.oid) || ')'
                   || coalesce(' → ' || pg_get_function_result(p.oid), '')
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (
                 SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        UNION ALL
        SELECT t.oid, t.typname::text, 'enumType', NULL::float8, NULL::text
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1 AND t.typtype = 'e'
           AND NOT EXISTS (
                 SELECT 1 FROM pg_depend d
                  WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
         ORDER BY kind, name, oid";

    let rows = client.query(SQL, &[&schema]).await?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            let kind: String = row.get("kind");
            Some(DbObject {
                oid: row.get("oid"),
                schema: schema.to_owned(),
                name: row.get("name"),
                kind: ObjectKind::from_sql(&kind)?,
                row_estimate: row.get("row_estimate"),
                detail: row.get("detail"),
            })
        })
        .collect())
}

/// The labels of an enum type in their declared order. Empty when `type_oid` is not an enum
/// (or no longer exists), which is how the cell editor tells a dropdown from a text box.
pub async fn enum_values(client: &Client, type_oid: u32) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT enumlabel::text FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder",
            &[&type_oid],
        )
        .await?;
    Ok(rows.iter().map(|row| row.get(0)).collect())
}

/// More columns than this are not sent: a database with a million columns would make the editor
/// slower to open than the completion is worth.
const MAX_COMPLETION_COLUMNS: usize = 200_000;
const MAX_COMPLETION_FUNCTIONS: i64 = 5_000;

/// Tables, views and their columns, and user-defined functions, for completion in the SQL editor.
pub async fn completion_schema(client: &Client) -> AppResult<CompletionSchema> {
    let path = client
        .query_one("SELECT current_schemas(false)::text[]", &[])
        .await?
        .get::<_, Vec<String>>(0);

    let rows = client
        .query(
            "SELECT n.nspname::text, c.relname::text, c.relkind::text,
                    array_agg(a.attname::text ORDER BY a.attnum),
                    array_agg(format_type(a.atttypid, a.atttypmod) ORDER BY a.attnum)
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
              WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
              GROUP BY n.nspname, c.relname, c.relkind
              ORDER BY n.nspname, c.relname",
            &[],
        )
        .await?;
    let mut tables = Vec::with_capacity(rows.len());
    let mut columns = 0usize;
    for row in &rows {
        let names: Vec<String> = row.get(3);
        let types: Vec<String> = row.get(4);
        columns += names.len();
        if columns > MAX_COMPLETION_COLUMNS {
            break;
        }
        tables.push(CompletionTable {
            schema: row.get(0),
            name: row.get(1),
            kind: match row.get::<_, String>(2).as_str() {
                "p" => ObjectKind::PartitionedTable,
                "f" => ObjectKind::ForeignTable,
                "v" => ObjectKind::View,
                "m" => ObjectKind::MaterializedView,
                _ => ObjectKind::Table,
            },
            columns: names
                .into_iter()
                .zip(types)
                .map(|(name, type_name)| CompletionColumn { name, type_name })
                .collect(),
        });
    }

    let functions = client
        .query(
            "SELECT n.nspname::text, p.proname::text,
                    '(' || pg_get_function_arguments(p.oid) || ')'
                      || CASE WHEN p.prokind = 'p' THEN ''
                              ELSE ' → ' || pg_get_function_result(p.oid) END
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.prokind IN ('f', 'p')
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg\\_toast%'
              ORDER BY n.nspname, p.proname
              LIMIT $1",
            &[&MAX_COMPLETION_FUNCTIONS],
        )
        .await?
        .iter()
        .map(|row| CompletionFunction {
            schema: row.get(0),
            name: row.get(1),
            signature: row.get(2),
        })
        .collect();

    Ok(CompletionSchema {
        search_path: path,
        tables,
        functions,
    })
}

/// The foreign keys of other tables that point at `schema.table`, for "referenced by". A key
/// of a partitioned table is listed once, not once per partition.
pub async fn incoming_foreign_keys(
    client: &Client,
    schema: &str,
    table: &str,
) -> AppResult<Vec<IncomingForeignKey>> {
    let rows = client
        .query(
            "SELECT con.conname::text, ns.nspname::text, c.relname::text,
                    array_agg(a.attname::text ORDER BY k.ord),
                    array_agg(ra.attname::text ORDER BY k.ord)
               FROM pg_constraint con
               CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
                         WITH ORDINALITY AS k(attnum, fattnum, ord)
               JOIN pg_class c ON c.oid = con.conrelid
               JOIN pg_namespace ns ON ns.oid = c.relnamespace
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
               JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.fattnum
               JOIN pg_class rc ON rc.oid = con.confrelid
               JOIN pg_namespace rn ON rn.oid = rc.relnamespace
              WHERE con.contype = 'f' AND con.conparentid = 0
                AND rn.nspname = $1 AND rc.relname = $2
              GROUP BY con.oid, con.conname, ns.nspname, c.relname
              ORDER BY ns.nspname, c.relname, con.conname",
            &[&schema, &table],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| IncomingForeignKey {
            constraint: row.get(0),
            schema: row.get(1),
            table: row.get(2),
            columns: row.get(3),
            referenced_columns: row.get(4),
        })
        .collect())
}

/// Columns, keys and the row identity of a table, view or materialized view.
pub async fn describe_table(
    client: &Client,
    schema: &str,
    table: &str,
) -> AppResult<TableDescription> {
    let relation = client
        .query_opt(
            "SELECT c.oid, c.relkind::text, obj_description(c.oid, 'pg_class')
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'f', 'v', 'm')",
            &[&schema, &table],
        )
        .await?
        .ok_or_else(|| AppError::NotFound(format!("table or view {schema}.{table}")))?;
    let oid: u32 = relation.get(0);
    let kind = match relation.get::<_, String>(1).as_str() {
        "p" => ObjectKind::PartitionedTable,
        "f" => ObjectKind::ForeignTable,
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        _ => ObjectKind::Table,
    };

    let mut columns = fetch_columns(client, oid).await?;
    let primary_key = fetch_primary_key(client, oid).await?;
    let foreign_keys = fetch_foreign_keys(client, oid).await?;
    for column in &mut columns {
        column.is_primary_key = primary_key.contains(&column.name);
        column.foreign_keys = foreign_keys
            .iter()
            .filter(|(name, _)| *name == column.name)
            .map(|(_, reference)| reference.clone())
            .collect();
    }

    let unique_index = if primary_key.is_empty() {
        fetch_unique_index(client, oid).await?
    } else {
        None
    };

    Ok(TableDescription {
        schema: schema.to_owned(),
        name: table.to_owned(),
        kind,
        comment: relation.get(2),
        columns,
        identity: decide_identity(kind, primary_key, unique_index),
    })
}

/// `base_type` is `format_type(oid, -1)`, not `NULL`: `NULL` prints `char(n)` as `character` and
/// `bit(n)` as `bit`, and casting text to those silently cuts the value to one character. `-1`
/// prints `bpchar` and `"bit"`, the unconstrained types, so a value is never shortened by the cast
/// and the column itself raises "value too long" on assignment.
async fn fetch_columns(client: &Client, oid: u32) -> AppResult<Vec<ColumnInfo>> {
    let rows = client
        .query(
            "SELECT a.attnum, a.attname::text,
                    format_type(a.atttypid, a.atttypmod), format_type(a.atttypid, -1),
                    a.atttypid, NOT a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text,
                    col_description(a.attrelid, a.attnum)
               FROM pg_attribute a
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum",
            &[&oid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            position: u16::try_from(row.get::<_, i16>(0)).unwrap_or(0),
            name: row.get(1),
            type_name: row.get(2),
            base_type: row.get(3),
            type_oid: row.get(4),
            nullable: row.get(5),
            default_value: row.get(6),
            identity: match row.get::<_, String>(7).as_str() {
                "a" => Some(ColumnIdentity::Always),
                "d" => Some(ColumnIdentity::ByDefault),
                _ => None,
            },
            generated: !row.get::<_, String>(8).is_empty(),
            comment: row.get(9),
            is_primary_key: false,
            foreign_keys: Vec::new(),
        })
        .collect())
}

/// Primary key columns in key order.
pub(crate) async fn fetch_primary_key(client: &Client, oid: u32) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT a.attname::text
               FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              WHERE i.indrelid = $1 AND i.indisprimary
              ORDER BY k.ord",
            &[&oid],
        )
        .await?;
    Ok(rows.iter().map(|row| row.get(0)).collect())
}

/// `(column of this table, what it points at)`, in constraint then column order.
pub(crate) async fn fetch_foreign_keys(
    client: &Client,
    oid: u32,
) -> AppResult<Vec<(String, ForeignKeyRef)>> {
    let rows = client
        .query(
            "SELECT a.attname::text, con.conname::text, rn.nspname::text, rc.relname::text,
                    ra.attname::text
               FROM pg_constraint con
               CROSS JOIN LATERAL unnest(con.conkey, con.confkey)
                         WITH ORDINALITY AS k(attnum, fattnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
               JOIN pg_class rc ON rc.oid = con.confrelid
               JOIN pg_namespace rn ON rn.oid = rc.relnamespace
               JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.fattnum
              WHERE con.conrelid = $1 AND con.contype = 'f'
              ORDER BY con.conname, k.ord",
            &[&oid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            (
                row.get(0),
                ForeignKeyRef {
                    constraint: row.get(1),
                    schema: row.get(2),
                    table: row.get(3),
                    column: row.get(4),
                },
            )
        })
        .collect())
}

/// The best unique index to identify rows with when there is no primary key: valid, not
/// partial, no expressions, immediate, and every column NOT NULL. Fewest columns wins.
async fn fetch_unique_index(client: &Client, oid: u32) -> AppResult<Option<Vec<String>>> {
    let row = client
        .query_opt(
            "SELECT array_agg(a.attname::text ORDER BY k.ord)
               FROM pg_index i
               CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
              WHERE i.indrelid = $1 AND i.indisunique AND NOT i.indisprimary
                AND i.indisvalid AND i.indimmediate
                AND i.indpred IS NULL AND i.indexprs IS NULL
              GROUP BY i.indexrelid
             HAVING bool_and(a.attnotnull)
              ORDER BY count(*), i.indexrelid
              LIMIT 1",
            &[&oid],
        )
        .await?;
    Ok(row.map(|row| row.get(0)))
}

/// ANG-8 D2: primary key, then a NOT NULL unique index, then `ctid`, else read-only.
pub fn decide_identity(
    kind: ObjectKind,
    primary_key: Vec<String>,
    unique_index: Option<Vec<String>>,
) -> RowIdentity {
    let read_only = |reason: &str| RowIdentity::ReadOnly {
        reason: reason.to_owned(),
    };
    match kind {
        ObjectKind::View => return read_only("Views can't be edited."),
        ObjectKind::MaterializedView => return read_only("Materialized views can't be edited."),
        ObjectKind::ForeignTable => return read_only("Foreign tables are read-only here."),
        _ => {}
    }
    if !primary_key.is_empty() {
        return RowIdentity::PrimaryKey {
            columns: primary_key,
        };
    }
    if let Some(columns) = unique_index {
        return RowIdentity::UniqueIndex { columns };
    }
    match kind {
        ObjectKind::PartitionedTable => read_only(
            "This partitioned table has no primary key or unique index, so a row can't be told \
             apart from rows in other partitions.",
        ),
        _ => RowIdentity::Ctid,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    #[test]
    fn primary_key_wins_over_a_unique_index() {
        assert_eq!(
            decide_identity(ObjectKind::Table, cols(&["a", "b"]), Some(cols(&["c"]))),
            RowIdentity::PrimaryKey {
                columns: cols(&["a", "b"])
            }
        );
    }

    #[test]
    fn unique_index_is_the_fallback() {
        assert_eq!(
            decide_identity(ObjectKind::Table, vec![], Some(cols(&["key"]))),
            RowIdentity::UniqueIndex {
                columns: cols(&["key"])
            }
        );
    }

    #[test]
    fn a_plain_table_without_keys_falls_back_to_ctid() {
        assert_eq!(
            decide_identity(ObjectKind::Table, vec![], None),
            RowIdentity::Ctid
        );
    }

    #[test]
    fn views_are_read_only_even_with_a_key() {
        for kind in [
            ObjectKind::View,
            ObjectKind::MaterializedView,
            ObjectKind::ForeignTable,
        ] {
            let identity = decide_identity(kind, cols(&["id"]), None);
            assert!(matches!(identity, RowIdentity::ReadOnly { .. }), "{kind:?}");
        }
    }

    #[test]
    fn partitioned_tables_never_use_ctid() {
        assert!(matches!(
            decide_identity(ObjectKind::PartitionedTable, vec![], None),
            RowIdentity::ReadOnly { .. }
        ));
        assert_eq!(
            decide_identity(ObjectKind::PartitionedTable, cols(&["id"]), None),
            RowIdentity::PrimaryKey {
                columns: cols(&["id"])
            }
        );
    }
}
