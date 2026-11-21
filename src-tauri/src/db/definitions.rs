//! The SQL behind a function, view, materialized view, sequence or enum type (ANG-39).
//!
//! Views are read under an empty `search_path` (like [`crate::db::structure`]), so the text names
//! every table in full and means the same wherever it is run.

use tokio_postgres::Client;

use crate::db::rows::quote_ident;
use crate::db::structure::literal;
use crate::error::{AppError, AppResult};
use crate::models::definitions::{ObjectDefinition, SequenceInfo};
use crate::models::schema::ObjectKind;

/// `schema.name`, quoted the way PostgreSQL does (only where it has to be), like the rest of the
/// text in a definition.
async fn qualified(client: &Client, schema: &str, name: &str) -> AppResult<String> {
    Ok(client
        .query_one(
            "SELECT quote_ident($1::text) || '.' || quote_ident($2::text)",
            &[&schema, &name],
        )
        .await?
        .get(0))
}

fn not_found(kind: &str, schema: &str, name: &str) -> AppError {
    AppError::NotFound(format!("{kind} {schema}.{name}"))
}

/// The definition of one object. `oid` tells overloaded functions apart.
pub async fn definition(
    client: &Client,
    kind: ObjectKind,
    schema: &str,
    name: &str,
    oid: u32,
) -> AppResult<ObjectDefinition> {
    let sql = match kind {
        ObjectKind::Function | ObjectKind::Procedure => function(client, schema, name, oid).await?,
        ObjectKind::View | ObjectKind::MaterializedView => {
            relation_definition(client, kind, schema, name).await?
        }
        ObjectKind::EnumType => enum_definition(client, schema, name, oid).await?,
        ObjectKind::Sequence => sequence_definition(client, schema, name).await?,
        _ => {
            return Err(AppError::Validation(
                "Tables have their DDL in the Structure view.".into(),
            ));
        }
    };
    let title = match kind {
        ObjectKind::Function | ObjectKind::Procedure => format!("{name}()"),
        _ => name.to_owned(),
    };
    Ok(ObjectDefinition { title, sql })
}

async fn function(client: &Client, schema: &str, name: &str, oid: u32) -> AppResult<String> {
    let row = client
        .query_opt(
            "SELECT pg_get_functiondef(p.oid), p.prokind::text
               FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE p.oid = $1 AND n.nspname = $2 AND p.proname = $3",
            // An aggregate has no function body: pg_get_functiondef would fail on it.
            &[&oid, &schema, &name],
        )
        .await;
    // `pg_get_functiondef` raises for an aggregate; say it in words instead.
    let row = match row {
        Ok(row) => row,
        Err(e)
            if e.as_db_error()
                .is_some_and(|d| d.message().contains("is an aggregate")) =>
        {
            return Err(AppError::Validation(
                "An aggregate has no source to show: it is made of other functions.".into(),
            ));
        }
        Err(e) => return Err(e.into()),
    };
    let row = row.ok_or_else(|| not_found("function", schema, name))?;
    let def: String = row.get(0);
    Ok(format!("{};\n", def.trim_end()))
}

async fn relation_definition(
    client: &Client,
    kind: ObjectKind,
    schema: &str,
    name: &str,
) -> AppResult<String> {
    let relkind = if kind == ObjectKind::View { "v" } else { "m" };
    client
        .batch_execute("BEGIN READ ONLY; SET LOCAL search_path = pg_catalog")
        .await?;
    let result = async {
        let row = client
            .query_opt(
                "SELECT pg_get_viewdef(c.oid, true), c.reloptions, c.relispopulated,
                        quote_ident(n.nspname) || '.' || quote_ident(c.relname),
                        array(SELECT pg_get_indexdef(i.indexrelid)
                                FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
                               WHERE i.indrelid = c.oid ORDER BY ic.relname)
                   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind::text = $3",
                &[&schema, &name, &relkind],
            )
            .await?
            .ok_or_else(|| not_found("view", schema, name))?;
        let body: String = row.get(0);
        let body = body.trim().trim_end_matches(';').trim().to_owned();
        let options: Vec<String> = row.get::<_, Option<Vec<String>>>(1).unwrap_or_default();
        let with = if options.is_empty() {
            String::new()
        } else {
            format!(" WITH ({})", options.join(", "))
        };
        let populated: bool = row.get(2);
        let qualified: String = row.get(3);
        let indexes: Vec<String> = row.get(4);
        Ok::<_, AppError>(if kind == ObjectKind::View {
            format!("CREATE OR REPLACE VIEW {qualified}{with} AS\n{body};\n")
        } else {
            let mut text = format!(
                "-- A materialized view can't be replaced in place: to change it, drop it and make it\n\
                 -- again. Dropping it also drops its indexes; they are made again below.\n\
                 DROP MATERIALIZED VIEW {qualified};\n\
                 CREATE MATERIALIZED VIEW {qualified}{with} AS\n{body}\nWITH {}DATA;\n",
                if populated { "" } else { "NO " }
            );
            for index in indexes {
                text.push_str(&format!("{index};\n"));
            }
            text
        })
    }
    .await;
    let _ = client.batch_execute("ROLLBACK").await;
    result
}

async fn enum_definition(client: &Client, schema: &str, name: &str, oid: u32) -> AppResult<String> {
    let found = client
        .query_opt(
            "SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
              WHERE t.oid = $1 AND n.nspname = $2 AND t.typname = $3 AND t.typtype = 'e'",
            &[&oid, &schema, &name],
        )
        .await?;
    if found.is_none() {
        return Err(not_found("enum type", schema, name));
    }
    let labels: Vec<String> = client
        .query(
            "SELECT enumlabel::text FROM pg_enum WHERE enumtypid = $1 ORDER BY enumsortorder",
            &[&oid],
        )
        .await?
        .iter()
        .map(|r| literal(&r.get::<_, String>(0)))
        .collect();
    let name = qualified(client, schema, name).await?;
    Ok(format!(
        "CREATE TYPE {name} AS ENUM ({});\n-- Add a value with: ALTER TYPE {name} ADD VALUE 'new_value';\n",
        labels.join(", "),
    ))
}

async fn sequence_definition(client: &Client, schema: &str, name: &str) -> AppResult<String> {
    let info = sequence_info(client, schema, name).await?;
    let table = qualified(client, schema, name).await?;
    let mut text = format!(
        "CREATE SEQUENCE {table} AS {} START WITH {} INCREMENT BY {} MINVALUE {} MAXVALUE {} CACHE {}{};\n",
        info.data_type,
        info.start,
        info.increment,
        info.min,
        info.max,
        info.cache,
        if info.cycle { " CYCLE" } else { "" }
    );
    if let Some(owner) = &info.owned_by {
        text.push_str(&format!("-- Owned by {owner}.\n"));
    }
    if let Some(last) = &info.last_value {
        text.push_str(&format!(
            "-- Where it is now: SELECT setval({}::regclass, {last}, true);\n",
            literal(&table)
        ));
    }
    Ok(text)
}

/// Settings and the current value of a sequence.
pub async fn sequence_info(client: &Client, schema: &str, name: &str) -> AppResult<SequenceInfo> {
    let row = client
        .query_opt(
            "SELECT format_type(s.seqtypid, NULL), s.seqstart::text, s.seqincrement::text,
                    s.seqmin::text, s.seqmax::text, s.seqcache::text, s.seqcycle,
                    (SELECT quote_ident(tn.nspname) || '.' || quote_ident(t.relname) || '.'
                            || quote_ident(a.attname)
                       FROM pg_depend d
                       JOIN pg_class t ON t.oid = d.refobjid
                       JOIN pg_namespace tn ON tn.oid = t.relnamespace
                       JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                        AND d.deptype IN ('a', 'i') LIMIT 1)
               FROM pg_sequence s
               JOIN pg_class c ON c.oid = s.seqrelid
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &name],
        )
        .await?
        .ok_or_else(|| not_found("sequence", schema, name))?;
    let current = client
        .query_one(
            &format!(
                "SELECT last_value::text, is_called FROM {}.{}",
                quote_ident(schema),
                quote_ident(name)
            ),
            &[],
        )
        .await?;
    let is_called: bool = current.get(1);
    Ok(SequenceInfo {
        data_type: row.get(0),
        start: row.get(1),
        increment: row.get(2),
        min: row.get(3),
        max: row.get(4),
        cache: row.get(5),
        cycle: row.get(6),
        last_value: is_called.then(|| current.get(0)),
        owned_by: row.get(7),
    })
}
