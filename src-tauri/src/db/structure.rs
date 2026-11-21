//! Structure of one table, view or materialized view, read from `pg_catalog`, and the DDL that
//! would create it again (ANG-36).
//!
//! The DDL is built from the catalog with the server's own `pg_get_*def` functions for anything
//! that has an expression in it (defaults, checks, indexes, triggers, views). It is split in two:
//!
//! - `ddl`: the table and what belongs to it. Foreign keys come last, as `ALTER TABLE`, so a
//!   table can be created before the ones it points at.
//! - `prerequisites`: what the table needs to exist first and is not part of it: extensions,
//!   enum/domain/composite/range types, sequences, and the functions its triggers, defaults and
//!   checks call. Ownership and grants are left out: the roles may not exist where it is run.

use std::collections::{BTreeSet, HashSet};

use tokio_postgres::Client;

use crate::db::introspect::{fetch_foreign_keys, fetch_primary_key};
use crate::db::rows::quote_ident;
use crate::error::{AppError, AppResult};
use crate::models::schema::{ColumnIdentity, ForeignKeyRef, ObjectKind};
use crate::models::structure::{
    ConstraintInfo, ConstraintKind, GeneratedKind, IndexInfo, Persistence, StructureColumn,
    TableInfo, TableStructure, TriggerInfo, TriggerState,
};

/// A future that can call itself (a type that is made of other types).
type BoxFuture<'a, T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send + 'a>>;

/// `'text'` as an SQL string literal that means the same whatever `standard_conforming_strings`
/// is: text with a backslash is written as `E'…'` with the backslashes doubled too (as
/// `pg_dump` does), so a `\'` in it can never end the string early.
pub(crate) fn literal(text: &str) -> String {
    if text.contains('\\') {
        format!("E'{}'", text.replace('\\', "\\\\").replace('\'', "''"))
    } else {
        format!("'{}'", text.replace('\'', "''"))
    }
}

/// A name for a `--` comment: a line break in it would end the comment and start SQL.
fn one_line(text: &str) -> String {
    text.replace(['\n', '\r'], " ")
}

/// A column with everything the DDL needs, before it is turned into the UI's shape.
struct Column {
    position: i16,
    /// Quoted if it has to be.
    quoted: String,
    name: String,
    type_name: String,
    not_null: bool,
    default_value: Option<String>,
    identity: Option<ColumnIdentity>,
    identity_options: String,
    generated: Option<GeneratedKind>,
    collation: Option<String>,
    comment: Option<String>,
    is_local: bool,
}

struct Relation {
    oid: u32,
    kind: ObjectKind,
    /// `schema.name`, quoted if they have to be.
    qualified: String,
    /// The schema alone, quoted if it has to be.
    schema: String,
    persistence: Persistence,
    populated: bool,
    partition_bound: Option<String>,
    partition_key: Option<String>,
    options: Vec<String>,
    is_partition: bool,
}

/// Everything read from the catalog about one relation, before it becomes the UI's shape.
struct Loaded {
    relation: Relation,
    owner: String,
    comment: Option<String>,
    reltuples: f64,
    total_bytes: f64,
    table_bytes: f64,
    index_bytes: f64,
    toast_bytes: f64,
    tablespace: Option<String>,
    access_method: Option<String>,
    row_security: bool,
    parents: Vec<String>,
    partitions: Vec<String>,
    columns: Vec<Column>,
    primary_key: Vec<String>,
    foreign_keys: Vec<(String, ForeignKeyRef)>,
    indexes: Vec<IndexRow>,
    constraints: Vec<ConstraintRow>,
    triggers: Vec<TriggerRow>,
}

async fn load(client: &Client, schema: &str, table: &str) -> AppResult<Loaded> {
    let row = client
        .query_opt(
            "SELECT c.oid, c.relkind::text, c.relpersistence::text,
                    pg_get_userbyid(c.relowner)::text, obj_description(c.oid, 'pg_class'),
                    c.reltuples::float8, pg_total_relation_size(c.oid)::float8,
                    pg_table_size(c.oid)::float8, pg_indexes_size(c.oid)::float8,
                    CASE WHEN c.reltoastrelid <> 0
                         THEN pg_total_relation_size(c.reltoastrelid)::float8 ELSE 0 END,
                    t.spcname::text, am.amname::text, c.relrowsecurity, c.relispartition,
                    CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
                    CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END,
                    c.reloptions, c.relispopulated,
                    quote_ident(n.nspname) || '.' || quote_ident(c.relname),
                    quote_ident(n.nspname)
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               LEFT JOIN pg_tablespace t ON t.oid = c.reltablespace
               LEFT JOIN pg_am am ON am.oid = c.relam
              WHERE n.nspname = $1 AND c.relname = $2
                AND c.relkind IN ('r', 'p', 'f', 'v', 'm')",
            &[&schema, &table],
        )
        .await?
        .ok_or_else(|| AppError::NotFound(format!("table or view {schema}.{table}")))?;

    let kind = match row.get::<_, String>(1).as_str() {
        "p" => ObjectKind::PartitionedTable,
        "f" => ObjectKind::ForeignTable,
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        _ => ObjectKind::Table,
    };
    let persistence = match row.get::<_, String>(2).as_str() {
        "u" => Persistence::Unlogged,
        "t" => Persistence::Temporary,
        _ => Persistence::Permanent,
    };
    let relation = Relation {
        oid: row.get(0),
        kind,
        qualified: row.get(18),
        schema: row.get(19),
        persistence,
        populated: row.get(17),
        partition_bound: row.get(15),
        partition_key: row.get(14),
        options: row.get::<_, Option<Vec<String>>>(16).unwrap_or_default(),
        is_partition: row.get(13),
    };
    let oid = relation.oid;
    let partitions = if kind == ObjectKind::PartitionedTable {
        partitions_of(client, oid).await?
    } else {
        Vec::new()
    };
    Ok(Loaded {
        owner: row.get(3),
        comment: row.get(4),
        reltuples: row.get(5),
        total_bytes: row.get(6),
        table_bytes: row.get(7),
        index_bytes: row.get(8),
        toast_bytes: row.get(9),
        tablespace: row.get(10),
        access_method: row.get(11),
        row_security: row.get(12),
        parents: parents_of(client, oid).await?,
        partitions,
        columns: fetch_columns(client, oid).await?,
        primary_key: fetch_primary_key(client, oid).await?,
        foreign_keys: fetch_foreign_keys(client, oid).await?,
        indexes: fetch_indexes(client, oid).await?,
        constraints: fetch_constraints(client, oid).await?,
        triggers: fetch_triggers(client, oid).await?,
        relation,
    })
}

/// The DDL and what it needs, written with every name qualified. The catalog functions leave out
/// the schema of anything on the `search_path`, which would make the text depend on the
/// connection it was read through; with an empty path (as `pg_dump` does) it never does.
async fn portable_ddl(client: &Client, schema: &str, table: &str) -> AppResult<(String, String)> {
    client
        .batch_execute("BEGIN READ ONLY; SET LOCAL search_path = pg_catalog")
        .await?;
    let result = async {
        let l = load(client, schema, table).await?;
        let ddl = build_ddl(
            client,
            &l.relation,
            &l.columns,
            &l.parents,
            &l.constraints,
            &l.indexes,
            &l.triggers,
        )
        .await?;
        let prerequisites = build_prerequisites(client, &l.relation).await?;
        Ok((ddl, prerequisites))
    }
    .await;
    // Whatever happened, give the connection back outside of the transaction.
    let _ = client.batch_execute("ROLLBACK").await;
    result
}

/// Everything about `schema.table`, for the Structure view.
pub async fn table_structure(
    client: &Client,
    schema: &str,
    table: &str,
) -> AppResult<TableStructure> {
    // The tables as the person sees them: names qualified only where the search path needs it.
    let l = load(client, schema, table).await?;
    let (ddl, prerequisites) = portable_ddl(client, schema, table).await?;
    let kind = l.relation.kind;

    let info = TableInfo {
        owner: l.owner,
        comment: l.comment,
        persistence: l.relation.persistence,
        // Negative (-1 since PostgreSQL 14): never analyzed. A view has no rows of its own.
        row_estimate: (l.reltuples >= 0.0 && !is_view(kind)).then_some(l.reltuples),
        total_bytes: l.total_bytes,
        table_bytes: l.table_bytes,
        index_bytes: l.index_bytes,
        toast_bytes: l.toast_bytes,
        tablespace: l.tablespace,
        access_method: l.access_method,
        partition_key: l.relation.partition_key.clone(),
        partition_bound: l.relation.partition_bound.clone(),
        parents: l.parents,
        partitions: l.partitions,
        row_security: l.row_security,
        options: l.relation.options.clone(),
        populated: (kind == ObjectKind::MaterializedView).then_some(l.relation.populated),
    };

    let primary_key = l.primary_key;
    let foreign_keys = l.foreign_keys;
    let columns = l
        .columns
        .into_iter()
        .map(|c| StructureColumn {
            position: u16::try_from(c.position).unwrap_or(0),
            is_primary_key: primary_key.contains(&c.name),
            foreign_keys: foreign_keys
                .iter()
                .filter(|(name, _)| *name == c.name)
                .map(|(_, reference)| reference.clone())
                .collect(),
            name: c.name,
            type_name: c.type_name,
            nullable: !c.not_null,
            default_value: c.default_value,
            identity: c.identity,
            generated: c.generated,
            collation: c.collation,
            comment: c.comment,
        })
        .collect();

    Ok(TableStructure {
        schema: schema.to_owned(),
        name: table.to_owned(),
        kind,
        info,
        columns,
        indexes: l.indexes.into_iter().map(|i| i.info).collect(),
        constraints: l.constraints.into_iter().map(|c| c.info).collect(),
        triggers: l.triggers.into_iter().map(|t| t.info).collect(),
        ddl,
        prerequisites,
    })
}

fn is_view(kind: ObjectKind) -> bool {
    matches!(kind, ObjectKind::View)
}

/// The tables this one inherits from, or the parent of a partition.
async fn parents_of(client: &Client, oid: u32) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
               FROM pg_inherits i
               JOIN pg_class c ON c.oid = i.inhparent
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE i.inhrelid = $1
              ORDER BY i.inhseqno",
            &[&oid],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

async fn partitions_of(client: &Client, oid: u32) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
               FROM pg_inherits i
               JOIN pg_class c ON c.oid = i.inhrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE i.inhparent = $1
              ORDER BY c.relname",
            &[&oid],
        )
        .await?;
    Ok(rows.iter().map(|r| r.get(0)).collect())
}

// ---- Columns -----------------------------------------------------------------------------------

async fn fetch_columns(client: &Client, oid: u32) -> AppResult<Vec<Column>> {
    let rows = client
        .query(
            "SELECT a.attnum, quote_ident(a.attname), a.attname::text,
                    format_type(a.atttypid, a.atttypmod), a.attnotnull,
                    pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text,
                    col_description(a.attrelid, a.attnum),
                    CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
                         THEN (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                                 FROM pg_collation co
                                 JOIN pg_namespace cn ON cn.oid = co.collnamespace
                                WHERE co.oid = a.attcollation)
                    END,
                    a.attislocal
               FROM pg_attribute a
               JOIN pg_type t ON t.oid = a.atttypid
               LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
              ORDER BY a.attnum",
            &[&oid],
        )
        .await?;

    // Identity columns own a sequence; its options are only written when they are not the defaults.
    let sequences = client
        .query(
            "SELECT a.attnum, s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache,
                    s.seqcycle, format_type(s.seqtypid, NULL)
               FROM pg_attribute a
               JOIN pg_depend d ON d.refobjid = a.attrelid AND d.refobjsubid = a.attnum
                               AND d.classid = 'pg_class'::regclass AND d.deptype = 'i'
               JOIN pg_sequence s ON s.seqrelid = d.objid
              WHERE a.attrelid = $1 AND a.attidentity <> ''",
            &[&oid],
        )
        .await?;

    Ok(rows
        .iter()
        .map(|row| {
            let position: i16 = row.get(0);
            let identity = match row.get::<_, String>(6).as_str() {
                "a" => Some(ColumnIdentity::Always),
                "d" => Some(ColumnIdentity::ByDefault),
                _ => None,
            };
            let identity_options = sequences
                .iter()
                .find(|s| s.get::<_, i16>(0) == position)
                .map(|s| {
                    sequence_options(SequenceOptions {
                        type_name: s.get(7),
                        start: s.get(1),
                        increment: s.get(2),
                        min: s.get(3),
                        max: s.get(4),
                        cache: s.get(5),
                        cycle: s.get(6),
                    })
                    .non_default
                })
                .unwrap_or_default();
            Column {
                position,
                quoted: row.get(1),
                name: row.get(2),
                type_name: row.get(3),
                not_null: row.get(4),
                default_value: row.get(5),
                identity,
                identity_options,
                generated: match row.get::<_, String>(7).as_str() {
                    "s" => Some(GeneratedKind::Stored),
                    "v" => Some(GeneratedKind::Virtual),
                    _ => None,
                },
                comment: row.get(8),
                collation: row.get(9),
                is_local: row.get(10),
            }
        })
        .collect())
}

struct SequenceOptions {
    type_name: String,
    start: i64,
    increment: i64,
    min: i64,
    max: i64,
    cache: i64,
    cycle: bool,
}

struct SequenceText {
    /// `START WITH 1000 INCREMENT BY 5 …`: only what differs from what Postgres would pick.
    non_default: String,
    /// Every option, for `CREATE SEQUENCE`.
    all: String,
}

fn sequence_options(o: SequenceOptions) -> SequenceText {
    let max_for_type = match o.type_name.as_str() {
        "smallint" => i64::from(i16::MAX),
        "integer" => i64::from(i32::MAX),
        _ => i64::MAX,
    };
    let descending = o.increment < 0;
    let default_min = if descending { -max_for_type - 1 } else { 1 };
    let default_max = if descending { -1 } else { max_for_type };
    let default_start = if descending { default_max } else { default_min };

    let mut changed = Vec::new();
    if o.start != default_start {
        changed.push(format!("START WITH {}", o.start));
    }
    if o.increment != 1 {
        changed.push(format!("INCREMENT BY {}", o.increment));
    }
    if o.min != default_min {
        changed.push(format!("MINVALUE {}", o.min));
    }
    if o.max != default_max {
        changed.push(format!("MAXVALUE {}", o.max));
    }
    if o.cache != 1 {
        changed.push(format!("CACHE {}", o.cache));
    }
    if o.cycle {
        changed.push("CYCLE".to_owned());
    }
    let all = format!(
        "START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {} CACHE {}{}",
        o.start,
        o.increment,
        o.min,
        o.max,
        o.cache,
        if o.cycle { " CYCLE" } else { "" }
    );
    SequenceText {
        non_default: changed.join(" "),
        all,
    }
}

// ---- Indexes, constraints, triggers -----------------------------------------------------------

struct IndexRow {
    info: IndexInfo,
    /// It belongs to a partitioned table's index: the parent's definition covers it.
    inherited: bool,
}

async fn fetch_indexes(client: &Client, oid: u32) -> AppResult<Vec<IndexRow>> {
    let rows = client
        .query(
            "SELECT ic.relname::text, pg_get_indexdef(i.indexrelid, 0, true),
                    array(SELECT pg_get_indexdef(i.indexrelid, k, true)
                            FROM generate_series(1, i.indnkeyatts::int) k ORDER BY k),
                    am.amname::text, i.indisunique, i.indisprimary, i.indisvalid,
                    i.indpred IS NOT NULL, pg_relation_size(i.indexrelid)::float8,
                    (SELECT con.conname::text FROM pg_constraint con
                      WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid
                        AND con.contype IN ('p', 'u', 'x') LIMIT 1),
                    obj_description(i.indexrelid, 'pg_class'),
                    EXISTS (SELECT 1 FROM pg_inherits h WHERE h.inhrelid = i.indexrelid)
               FROM pg_index i
               JOIN pg_class ic ON ic.oid = i.indexrelid
               JOIN pg_am am ON am.oid = ic.relam
              WHERE i.indrelid = $1
              ORDER BY i.indisprimary DESC, ic.relname",
            &[&oid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| IndexRow {
            info: IndexInfo {
                name: row.get(0),
                definition: row.get(1),
                columns: row.get(2),
                method: row.get(3),
                unique: row.get(4),
                primary: row.get(5),
                valid: row.get(6),
                partial: row.get(7),
                size_bytes: row.get(8),
                constraint: row.get(9),
                comment: row.get(10),
            },
            inherited: row.get(11),
        })
        .collect())
}

struct ConstraintRow {
    info: ConstraintInfo,
    /// Quoted for DDL.
    quoted_name: String,
}

async fn fetch_constraints(client: &Client, oid: u32) -> AppResult<Vec<ConstraintRow>> {
    let rows = client
        .query(
            "SELECT con.conname::text, quote_ident(con.conname), con.contype::text,
                    pg_get_constraintdef(con.oid, true),
                    array(SELECT a.attname::text
                            FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                           ORDER BY k.ord),
                    (SELECT quote_ident(rn.nspname) || '.' || quote_ident(rc.relname)
                       FROM pg_class rc JOIN pg_namespace rn ON rn.oid = rc.relnamespace
                      WHERE rc.oid = con.confrelid AND con.contype = 'f'),
                    con.condeferrable, con.condeferred, con.convalidated,
                    obj_description(con.oid, 'pg_constraint')
               FROM pg_constraint con
              WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'c', 'f', 'x')
                AND con.conparentid = 0
              ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'x' THEN 2
                                        WHEN 'c' THEN 3 ELSE 4 END, con.conname",
            &[&oid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let kind = match row.get::<_, String>(2).as_str() {
                "p" => ConstraintKind::PrimaryKey,
                "u" => ConstraintKind::Unique,
                "c" => ConstraintKind::Check,
                "x" => ConstraintKind::Exclusion,
                _ => ConstraintKind::ForeignKey,
            };
            ConstraintRow {
                quoted_name: row.get(1),
                info: ConstraintInfo {
                    name: row.get(0),
                    kind,
                    definition: row.get(3),
                    columns: row.get(4),
                    references: row.get(5),
                    deferrable: row.get(6),
                    initially_deferred: row.get(7),
                    validated: row.get(8),
                    comment: row.get(9),
                },
            }
        })
        .collect())
}

struct TriggerRow {
    info: TriggerInfo,
    quoted_name: String,
}

async fn fetch_triggers(client: &Client, oid: u32) -> AppResult<Vec<TriggerRow>> {
    let rows = client
        .query(
            "SELECT t.tgname::text, quote_ident(t.tgname), pg_get_triggerdef(t.oid, true),
                    t.tgenabled::text, t.tgtype::int4,
                    quote_ident(pn.nspname) || '.' || quote_ident(p.proname)
               FROM pg_trigger t
               JOIN pg_proc p ON p.oid = t.tgfoid
               JOIN pg_namespace pn ON pn.oid = p.pronamespace
              WHERE t.tgrelid = $1 AND NOT t.tgisinternal AND t.tgparentid = 0
              ORDER BY t.tgname",
            &[&oid],
        )
        .await?;
    Ok(rows
        .iter()
        .map(|row| {
            let tgtype: i32 = row.get(4);
            let timing = if tgtype & 64 != 0 {
                "INSTEAD OF"
            } else if tgtype & 2 != 0 {
                "BEFORE"
            } else {
                "AFTER"
            };
            let events = [
                (4, "INSERT"),
                (8, "DELETE"),
                (16, "UPDATE"),
                (32, "TRUNCATE"),
            ]
            .iter()
            .filter(|(bit, _)| tgtype & bit != 0)
            .map(|(_, name)| (*name).to_owned())
            .collect();
            let state = match row.get::<_, String>(3).as_str() {
                "D" => TriggerState::Disabled,
                "R" => TriggerState::Replica,
                "A" => TriggerState::Always,
                _ => TriggerState::Enabled,
            };
            TriggerRow {
                quoted_name: row.get(1),
                info: TriggerInfo {
                    name: row.get(0),
                    timing: timing.to_owned(),
                    events,
                    per_row: tgtype & 1 != 0,
                    function: row.get(5),
                    state,
                    definition: row.get(2),
                },
            }
        })
        .collect())
}

// ---- DDL ---------------------------------------------------------------------------------------

fn column_line(c: &Column) -> String {
    let mut line = format!("{} {}", c.quoted, c.type_name);
    if let Some(collation) = &c.collation {
        line.push_str(&format!(" COLLATE {collation}"));
    }
    if let Some(kind) = c.generated {
        let how = match kind {
            GeneratedKind::Stored => "STORED",
            GeneratedKind::Virtual => "VIRTUAL",
        };
        let expression = c.default_value.as_deref().unwrap_or("NULL");
        line.push_str(&format!(" GENERATED ALWAYS AS ({expression}) {how}"));
    } else if let Some(identity) = c.identity {
        let when = match identity {
            ColumnIdentity::Always => "ALWAYS",
            ColumnIdentity::ByDefault => "BY DEFAULT",
        };
        line.push_str(&format!(" GENERATED {when} AS IDENTITY"));
        if !c.identity_options.is_empty() {
            line.push_str(&format!(" ({})", c.identity_options));
        }
    } else if let Some(default) = &c.default_value {
        line.push_str(&format!(" DEFAULT {default}"));
    }
    if c.not_null {
        line.push_str(" NOT NULL");
    }
    line
}

fn with_options(options: &[String]) -> String {
    if options.is_empty() {
        String::new()
    } else {
        format!(" WITH ({})", options.join(", "))
    }
}

async fn build_ddl(
    client: &Client,
    rel: &Relation,
    columns: &[Column],
    parents: &[String],
    constraints: &[ConstraintRow],
    indexes: &[IndexRow],
    triggers: &[TriggerRow],
) -> AppResult<String> {
    let q = &rel.qualified;
    let mut sections: Vec<String> = Vec::new();

    match rel.kind {
        ObjectKind::View | ObjectKind::MaterializedView => {
            let definition: String = client
                .query_one("SELECT pg_get_viewdef($1::oid, true)", &[&rel.oid])
                .await?
                .get(0);
            let body = definition.trim().trim_end_matches(';').trim();
            if rel.kind == ObjectKind::View {
                sections.push(format!(
                    "CREATE VIEW {q}{} AS\n{body};",
                    with_options(&rel.options)
                ));
            } else {
                sections.push(format!(
                    "CREATE MATERIALIZED VIEW {q}{} AS\n{body}\nWITH {}DATA;",
                    with_options(&rel.options),
                    if rel.populated { "" } else { "NO " }
                ));
            }
        }
        ObjectKind::ForeignTable => {
            let row = client
                .query_opt(
                    "SELECT quote_ident(s.srvname), ft.ftoptions
                       FROM pg_foreign_table ft JOIN pg_foreign_server s ON s.oid = ft.ftserver
                      WHERE ft.ftrelid = $1",
                    &[&rel.oid],
                )
                .await?;
            let (server, options) = row.map_or((String::new(), Vec::new()), |r| {
                (
                    r.get(0),
                    r.get::<_, Option<Vec<String>>>(1).unwrap_or_default(),
                )
            });
            let lines: Vec<String> = columns
                .iter()
                .map(|c| format!("    {}", column_line(c)))
                .collect();
            let options = if options.is_empty() {
                String::new()
            } else {
                let pairs: Vec<String> = options
                    .iter()
                    .map(|o| {
                        let (key, value) = o.split_once('=').unwrap_or((o, ""));
                        format!("{} {}", quote_ident(key), literal(value))
                    })
                    .collect();
                format!("\nOPTIONS ({})", pairs.join(", "))
            };
            sections.push(format!(
                "CREATE FOREIGN TABLE {q} (\n{}\n)\nSERVER {server}{options};",
                lines.join(",\n")
            ));
        }
        _ => sections.push(create_table(rel, columns, parents, constraints)),
    }

    // Sequences owned by a column go with the table: `OWNED BY` needs the table to exist.
    let owned = owned_sequences(client, rel.oid).await?;
    if !owned.is_empty() {
        sections.push(owned.join("\n"));
    }

    let own_indexes: Vec<String> = indexes
        .iter()
        .filter(|i| i.info.constraint.is_none() && !i.inherited)
        .map(|i| format!("{};", i.info.definition))
        .collect();
    if !own_indexes.is_empty() {
        sections.push(own_indexes.join("\n"));
    }

    // Foreign keys, and anything `NOT VALID` (which a `CREATE TABLE` can't say), come after.
    let later: Vec<String> = constraints
        .iter()
        .filter(|c| c.info.kind == ConstraintKind::ForeignKey || !c.info.validated)
        .map(|c| {
            format!(
                "ALTER TABLE {q}\n    ADD CONSTRAINT {} {};",
                c.quoted_name, c.info.definition
            )
        })
        .collect();
    if !later.is_empty() && !matches!(rel.kind, ObjectKind::View | ObjectKind::MaterializedView) {
        sections.push(later.join("\n"));
    }

    let trigger_lines: Vec<String> = triggers
        .iter()
        .flat_map(|t| {
            let mut lines = vec![format!("{};", t.info.definition)];
            match t.info.state {
                TriggerState::Enabled => {}
                TriggerState::Disabled => lines.push(format!(
                    "ALTER TABLE {q} DISABLE TRIGGER {};",
                    t.quoted_name
                )),
                TriggerState::Replica => lines.push(format!(
                    "ALTER TABLE {q} ENABLE REPLICA TRIGGER {};",
                    t.quoted_name
                )),
                TriggerState::Always => lines.push(format!(
                    "ALTER TABLE {q} ENABLE ALWAYS TRIGGER {};",
                    t.quoted_name
                )),
            }
            lines
        })
        .collect();
    if !trigger_lines.is_empty() {
        sections.push(trigger_lines.join("\n"));
    }

    // Comments.
    let object = match rel.kind {
        ObjectKind::View => "VIEW",
        ObjectKind::MaterializedView => "MATERIALIZED VIEW",
        ObjectKind::ForeignTable => "FOREIGN TABLE",
        _ => "TABLE",
    };
    let mut comments = Vec::new();
    let table_comment: Option<String> = client
        .query_one("SELECT obj_description($1::oid, 'pg_class')", &[&rel.oid])
        .await?
        .get(0);
    if let Some(text) = table_comment {
        comments.push(format!("COMMENT ON {object} {q} IS {};", literal(&text)));
    }
    for c in columns {
        if let Some(text) = &c.comment {
            comments.push(format!(
                "COMMENT ON COLUMN {q}.{} IS {};",
                c.quoted,
                literal(text)
            ));
        }
    }
    for c in constraints {
        if let Some(text) = &c.info.comment {
            comments.push(format!(
                "COMMENT ON CONSTRAINT {} ON {q} IS {};",
                c.quoted_name,
                literal(text)
            ));
        }
    }
    for i in indexes.iter().filter(|i| !i.inherited) {
        if let Some(text) = &i.info.comment {
            let quoted: String = client
                .query_one("SELECT quote_ident($1::text)", &[&i.info.name])
                .await?
                .get(0);
            // The index is in the table's schema; that one comes quoted from the catalog.
            comments.push(format!(
                "COMMENT ON INDEX {}.{quoted} IS {};",
                rel.schema,
                literal(text)
            ));
        }
    }
    if !comments.is_empty() {
        sections.push(comments.join("\n"));
    }

    Ok(sections.join("\n\n") + "\n")
}

fn create_table(
    rel: &Relation,
    columns: &[Column],
    parents: &[String],
    constraints: &[ConstraintRow],
) -> String {
    let q = &rel.qualified;
    let unlogged = match rel.persistence {
        Persistence::Unlogged => "UNLOGGED ",
        Persistence::Temporary => "TEMPORARY ",
        Persistence::Permanent => "",
    };
    // Constraints written inside `CREATE TABLE`: everything but foreign keys and `NOT VALID`.
    let inline: Vec<String> = constraints
        .iter()
        .filter(|c| c.info.kind != ConstraintKind::ForeignKey && c.info.validated)
        .map(|c| format!("    CONSTRAINT {} {}", c.quoted_name, c.info.definition))
        .collect();

    let mut text = String::new();
    if rel.is_partition {
        // A partition is its parent's columns plus a bound.
        let parent = parents.first().map_or("", String::as_str);
        let bound = rel.partition_bound.as_deref().unwrap_or("DEFAULT");
        text.push_str(&format!(
            "CREATE {unlogged}TABLE {q} PARTITION OF {parent}\n    {bound}"
        ));
        if let Some(key) = &rel.partition_key {
            text.push_str(&format!("\nPARTITION BY {key}"));
        }
        text.push_str(&with_options(&rel.options));
        text.push(';');
        return text;
    }

    // With INHERITS the inherited columns come from the parents, so only the local ones are listed.
    let listed: Vec<&Column> = columns
        .iter()
        .filter(|c| parents.is_empty() || c.is_local)
        .collect();
    let mut lines: Vec<String> = listed
        .iter()
        .map(|c| format!("    {}", column_line(c)))
        .collect();
    lines.extend(inline);
    text.push_str(&format!(
        "CREATE {unlogged}TABLE {q} (\n{}\n)",
        lines.join(",\n")
    ));
    if !parents.is_empty() {
        text.push_str(&format!("\nINHERITS ({})", parents.join(", ")));
    }
    if let Some(key) = &rel.partition_key {
        text.push_str(&format!("\nPARTITION BY {key}"));
    }
    text.push_str(&with_options(&rel.options));
    text.push(';');
    text
}

/// `ALTER SEQUENCE … OWNED BY table.column` for the sequences a column of this table owns
/// (serial columns).
async fn owned_sequences(client: &Client, oid: u32) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname), quote_ident(a.attname)
               FROM pg_depend d
               JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
               JOIN pg_namespace sn ON sn.oid = s.relnamespace
               JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
              WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
                AND d.refobjid = $1 AND d.deptype = 'a'
                AND EXISTS (SELECT 1 FROM pg_depend u
                              JOIN pg_attrdef ad ON u.classid = 'pg_attrdef'::regclass
                                                AND u.objid = ad.oid
                             WHERE ad.adrelid = $1 AND u.refobjid = s.oid)
              ORDER BY 1",
            &[&oid],
        )
        .await?;
    let table: String = client
        .query_one(
            "SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname)
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = $1",
            &[&oid],
        )
        .await?
        .get(0);
    Ok(rows
        .iter()
        .map(|r| {
            let sequence: String = r.get(0);
            let column: String = r.get(1);
            format!("ALTER SEQUENCE {sequence} OWNED BY {table}.{column};")
        })
        .collect())
}

// ---- Prerequisites -----------------------------------------------------------------------------

async fn build_prerequisites(client: &Client, rel: &Relation) -> AppResult<String> {
    let mut extensions: Vec<String> = Vec::new();
    let mut types: Vec<String> = Vec::new();
    // Schemas other than `public` have to exist before anything is created in them.
    let mut schemas: BTreeSet<String> = BTreeSet::new();
    schemas.insert(rel.schema.clone());

    // The types the columns use (an array column needs its element type).
    let type_rows = client
        .query(
            "SELECT DISTINCT CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END
               FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
              WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped",
            &[&rel.oid],
        )
        .await?;
    let mut type_oids: Vec<u32> = type_rows.iter().map(|r| r.get(0)).collect();
    type_oids.sort_unstable();
    let mut seen = HashSet::new();
    for oid in type_oids {
        type_prerequisites(
            client,
            oid,
            &mut seen,
            &mut extensions,
            &mut types,
            &mut schemas,
        )
        .await?;
    }

    let sequences = sequence_prerequisites(client, rel.oid, &mut schemas).await?;
    let functions = function_prerequisites(client, rel.oid, &mut schemas).await?;

    let mut statements: Vec<String> = schemas
        .iter()
        .filter(|s| s.as_str() != "public")
        .map(|schema| format!("CREATE SCHEMA IF NOT EXISTS {schema};"))
        .collect();
    statements.extend(extensions);
    statements.extend(types);
    statements.extend(sequences);
    statements.extend(functions);
    Ok(if statements.is_empty() {
        String::new()
    } else {
        statements.join("\n\n") + "\n"
    })
}

/// The statement that creates a user-defined type (and, first, the types it is made of).
fn type_prerequisites<'a>(
    client: &'a Client,
    oid: u32,
    seen: &'a mut HashSet<u32>,
    extensions: &'a mut Vec<String>,
    out: &'a mut Vec<String>,
    schemas: &'a mut BTreeSet<String>,
) -> BoxFuture<'a, AppResult<()>> {
    Box::pin(async move {
        if !seen.insert(oid) {
            return Ok(());
        }
        let Some(row) = client
            .query_opt(
                "SELECT n.nspname::text, quote_ident(n.nspname) || '.' || quote_ident(t.typname),
                        t.typtype::text, t.typbasetype, t.typnotnull,
                        pg_get_expr(t.typdefaultbin, 0), t.typrelid, t.typelem, t.typcategory::text,
                        format_type(t.typbasetype, t.typtypmod),
                        (SELECT quote_ident(e.extname) || ' WITH SCHEMA ' || quote_ident(en.nspname)
                           FROM pg_depend d
                           JOIN pg_extension e ON e.oid = d.refobjid
                           JOIN pg_namespace en ON en.oid = e.extnamespace
                          WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid
                            AND d.deptype = 'e' LIMIT 1),
                        (SELECT c.relkind::text FROM pg_class c WHERE c.oid = t.typrelid),
                        quote_ident(n.nspname)
                   FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                  WHERE t.oid = $1",
                &[&oid],
            )
            .await?
        else {
            return Ok(());
        };
        let namespace: String = row.get(0);
        if namespace == "pg_catalog" || namespace == "information_schema" {
            return Ok(());
        }
        let qualified: String = row.get(1);
        let typtype: String = row.get(2);
        let schema_quoted: String = row.get(12);
        let base_type: u32 = row.get(3);
        let not_null: bool = row.get(4);
        let default: Option<String> = row.get(5);
        let rel_oid: u32 = row.get(6);
        let element: u32 = row.get(7);
        let category: String = row.get(8);
        let base_name: String = row.get(9);
        let extension: Option<String> = row.get(10);
        let rel_kind: Option<String> = row.get(11);

        if let Some(extension) = extension {
            let statement = format!("CREATE EXTENSION IF NOT EXISTS {extension};");
            if !extensions.contains(&statement) {
                extensions.push(statement);
            }
            return Ok(());
        }
        if category == "A" && element != 0 {
            return type_prerequisites(client, element, seen, extensions, out, schemas).await;
        }

        if matches!(typtype.as_str(), "e" | "d" | "r")
            || (typtype == "c" && rel_kind.as_deref() == Some("c"))
        {
            schemas.insert(schema_quoted);
        }
        match typtype.as_str() {
            "e" => {
                let labels = client
                    .query(
                        "SELECT enumlabel::text FROM pg_enum WHERE enumtypid = $1
                          ORDER BY enumsortorder",
                        &[&oid],
                    )
                    .await?;
                let list: Vec<String> = labels
                    .iter()
                    .map(|r| literal(&r.get::<_, String>(0)))
                    .collect();
                out.push(format!(
                    "CREATE TYPE {qualified} AS ENUM ({});",
                    list.join(", ")
                ));
            }
            "d" => {
                type_prerequisites(client, base_type, seen, extensions, out, schemas).await?;
                let checks = client
                    .query(
                        "SELECT quote_ident(conname), pg_get_constraintdef(oid, true)
                           FROM pg_constraint WHERE contypid = $1 ORDER BY conname",
                        &[&oid],
                    )
                    .await?;
                let mut text = format!("CREATE DOMAIN {qualified} AS {base_name}");
                if let Some(default) = default {
                    text.push_str(&format!(" DEFAULT {default}"));
                }
                if not_null {
                    text.push_str(" NOT NULL");
                }
                for check in &checks {
                    text.push_str(&format!(
                        "\n    CONSTRAINT {} {}",
                        check.get::<_, String>(0),
                        check.get::<_, String>(1)
                    ));
                }
                text.push(';');
                out.push(text);
            }
            "c" if rel_kind.as_deref() == Some("c") => {
                let attributes = client
                    .query(
                        "SELECT quote_ident(attname), format_type(atttypid, atttypmod), atttypid
                           FROM pg_attribute
                          WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped ORDER BY attnum",
                        &[&rel_oid],
                    )
                    .await?;
                let mut lines = Vec::new();
                for attribute in &attributes {
                    type_prerequisites(client, attribute.get(2), seen, extensions, out, schemas)
                        .await?;
                    lines.push(format!(
                        "    {} {}",
                        attribute.get::<_, String>(0),
                        attribute.get::<_, String>(1)
                    ));
                }
                out.push(format!(
                    "CREATE TYPE {qualified} AS (\n{}\n);",
                    lines.join(",\n")
                ));
            }
            "r" => {
                let subtype = client
                    .query_one(
                        "SELECT rngsubtype, format_type(rngsubtype, NULL) FROM pg_range
                          WHERE rngtypid = $1",
                        &[&oid],
                    )
                    .await?;
                type_prerequisites(client, subtype.get(0), seen, extensions, out, schemas).await?;
                out.push(format!(
                    "CREATE TYPE {qualified} AS RANGE (SUBTYPE = {});",
                    subtype.get::<_, String>(1)
                ));
            }
            // A table's row type, or a base type from somewhere we can't see: say so.
            _ => out.push(format!("-- {} must already exist.", one_line(&qualified))),
        }
        Ok(())
    })
}

/// `CREATE SEQUENCE` for the sequences the column defaults call `nextval` on.
async fn sequence_prerequisites(
    client: &Client,
    oid: u32,
    schemas: &mut BTreeSet<String>,
) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT quote_ident(sn.nspname) || '.' || quote_ident(s.relname),
                    format_type(sq.seqtypid, NULL), sq.seqstart, sq.seqincrement, sq.seqmin,
                    sq.seqmax, sq.seqcache, sq.seqcycle, quote_ident(sn.nspname)
               FROM pg_class s
               JOIN pg_namespace sn ON sn.oid = s.relnamespace
               JOIN pg_sequence sq ON sq.seqrelid = s.oid
              WHERE s.relkind = 'S'
                AND s.oid IN (SELECT d.refobjid
                                FROM pg_depend d
                                JOIN pg_attrdef ad ON d.classid = 'pg_attrdef'::regclass
                                                  AND d.objid = ad.oid
                               WHERE ad.adrelid = $1 AND d.refclassid = 'pg_class'::regclass)
              ORDER BY 1",
            &[&oid],
        )
        .await?;
    schemas.extend(rows.iter().map(|row| row.get::<_, String>(8)));
    Ok(rows
        .iter()
        .map(|row| {
            let type_name: String = row.get(1);
            let options = sequence_options(SequenceOptions {
                type_name: type_name.clone(),
                start: row.get(2),
                increment: row.get(3),
                min: row.get(4),
                max: row.get(5),
                cache: row.get(6),
                cycle: row.get(7),
            });
            format!(
                "CREATE SEQUENCE {} AS {type_name} {};",
                row.get::<_, String>(0),
                options.all
            )
        })
        .collect())
}

/// The functions that triggers, column defaults and check constraints of this table call, as
/// `CREATE OR REPLACE FUNCTION`, except the ones from an extension or the system.
async fn function_prerequisites(
    client: &Client,
    oid: u32,
    schemas: &mut BTreeSet<String>,
) -> AppResult<Vec<String>> {
    let rows = client
        .query(
            "SELECT pg_get_functiondef(p.oid), quote_ident(n.nspname)
               FROM pg_proc p
               JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid IN (
                      SELECT tgfoid FROM pg_trigger WHERE tgrelid = $1 AND NOT tgisinternal
                      UNION
                      SELECT d.refobjid FROM pg_depend d
                        JOIN pg_attrdef ad ON d.classid = 'pg_attrdef'::regclass AND d.objid = ad.oid
                       WHERE ad.adrelid = $1 AND d.refclassid = 'pg_proc'::regclass
                      UNION
                      SELECT d.refobjid FROM pg_depend d
                        JOIN pg_constraint c ON d.classid = 'pg_constraint'::regclass
                                            AND d.objid = c.oid
                       WHERE c.conrelid = $1 AND d.refclassid = 'pg_proc'::regclass)
                AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                AND p.prokind IN ('f', 'p')
                AND NOT EXISTS (SELECT 1 FROM pg_depend e
                                 WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid
                                   AND e.deptype = 'e')
              ORDER BY p.oid",
            &[&oid],
        )
        .await?;
    schemas.extend(rows.iter().map(|r| r.get::<_, String>(1)));
    Ok(rows
        .iter()
        .map(|r| format!("{};", r.get::<_, String>(0).trim_end()))
        .collect())
}
