//! Write staged edits back: one transaction, every statement checked (ANG-23, ANG-8 D1/D2/D7).
//!
//! Same rule as `rows`: **no value is ever pasted into the SQL.** A cell value is a bound
//! parameter sent as `text` and cast by the server (`$1::text::numeric`, the type coming from
//! the catalog), so `varchar(3)` overflows raise an error instead of truncating and a
//! `bigint` above 2^53 stays exact. `NULL` is a bound `None`, `DEFAULT` is the keyword.
//! Identifiers are checked against the catalog, then quoted.
//!
//! Order inside the transaction: deletes (they free keys), updates, inserts. Every `UPDATE` and
//! `DELETE` must touch exactly one row; if not, the row was changed or deleted by someone else
//! and the whole batch rolls back.
//!
//! [`preview`] builds the same statements with the values written into the text, for the UI to
//! show. That text is never executed.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{Client, Row};

use crate::db::introspect;
use crate::db::rows::{find_column, quote_ident, relation};
use crate::error::{AppError, AppResult};
use crate::models::changes::{ApplyResult, CellValue, RowRef, TableChanges};
use crate::models::schema::{ColumnIdentity, ColumnInfo, RowIdentity, TableDescription};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Delete,
    Update,
    Insert,
}

/// One statement of the batch.
#[derive(Debug, PartialEq, Eq)]
pub struct Statement {
    kind: Kind,
    /// "update row id = 7": what the user sees when this one fails.
    pub label: String,
    pub sql: String,
    /// Values for `$1`, `$2`, …, all sent as `text`. `None` is SQL `NULL`.
    pub params: Vec<Option<String>>,
}

/// Turns values into SQL: placeholders when running, literals when previewing.
struct Binder {
    params: Vec<Option<String>>,
    inline: bool,
}

impl Binder {
    fn new(inline: bool) -> Self {
        Self {
            params: Vec::new(),
            inline,
        }
    }

    /// `$n::text::<type>` (or the literal, for a preview). `None` is `NULL`.
    fn typed(&mut self, value: Option<&str>, cast: &str) -> String {
        if self.inline {
            return value.map_or_else(|| "NULL".to_owned(), literal);
        }
        self.params.push(value.map(str::to_owned));
        format!("${}::text::{cast}", self.params.len())
    }

    fn cell(&mut self, value: &CellValue, column: &ColumnInfo) -> String {
        match value {
            CellValue::Default => "DEFAULT".to_owned(),
            CellValue::Null => self.typed(None, &column.base_type),
            CellValue::Value { text } => self.typed(Some(text), &column.base_type),
        }
    }
}

/// `'text'` with `'` doubled. Only used for the preview.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The cells to write, in table column order. Generated columns and `GENERATED ALWAYS`
/// identities only accept `DEFAULT`.
fn writes<'a>(
    desc: &'a TableDescription,
    values: &'a BTreeMap<String, CellValue>,
) -> AppResult<Vec<(&'a ColumnInfo, &'a CellValue)>> {
    let mut cells = Vec::with_capacity(values.len());
    for (name, value) in values {
        let column = find_column(desc, name)?;
        let locked = column.generated || column.identity == Some(ColumnIdentity::Always);
        if locked && *value != CellValue::Default {
            return Err(AppError::Validation(format!(
                "column \"{name}\" is generated and can't be written"
            )));
        }
        cells.push(column);
    }
    let mut pairs: Vec<_> = cells.into_iter().zip(values.values()).collect();
    pairs.sort_by_key(|(column, _)| column.position);
    Ok(pairs)
}

/// `WHERE …` for one row, plus how to name the row to the user.
fn where_row(
    desc: &TableDescription,
    row: &RowRef,
    binder: &mut Binder,
) -> AppResult<(String, String)> {
    match (&desc.identity, row) {
        (RowIdentity::ReadOnly { reason }, _) => Err(AppError::Validation(reason.clone())),
        (
            RowIdentity::PrimaryKey { columns } | RowIdentity::UniqueIndex { columns },
            RowRef::Key {
                columns: given,
                values,
            },
        ) => {
            let expected: BTreeSet<&str> = columns.iter().map(String::as_str).collect();
            let got: BTreeSet<&str> = given.iter().map(String::as_str).collect();
            if expected != got || given.len() != columns.len() || values.len() != given.len() {
                return Err(AppError::Validation(format!(
                    "rows of {} are identified by ({}), not ({})",
                    desc.name,
                    columns.join(", "),
                    given.join(", ")
                )));
            }
            let mut conditions = Vec::new();
            let mut named = Vec::new();
            for (name, value) in given.iter().zip(values) {
                let column = find_column(desc, name)?;
                conditions.push(format!(
                    "{} = {}",
                    quote_ident(name),
                    binder.typed(Some(value), &column.base_type)
                ));
                named.push(format!("{name} = {value}"));
            }
            Ok((conditions.join(" AND "), named.join(", ")))
        }
        (RowIdentity::Ctid, RowRef::Ctid { ctid }) => Ok((
            format!("ctid = {}", binder.typed(Some(ctid), "tid")),
            format!("ctid {ctid}"),
        )),
        _ => Err(AppError::Validation(format!(
            "the row reference doesn't match how {} identifies its rows",
            desc.name
        ))),
    }
}

fn no_repeats(rows: impl Iterator<Item = String>, what: &str) -> AppResult<()> {
    let mut seen = HashSet::new();
    for row in rows {
        if !seen.insert(row.clone()) {
            return Err(AppError::Validation(format!(
                "the same row is {what} twice ({row})"
            )));
        }
    }
    Ok(())
}

/// The statements for `changes`, in the order they run. `inline` writes values into the text
/// (for a preview) instead of binding them, and leaves out `RETURNING`.
pub fn build(
    desc: &TableDescription,
    changes: &TableChanges,
    inline: bool,
) -> AppResult<Vec<Statement>> {
    if changes.is_empty() {
        return Ok(Vec::new());
    }
    if let RowIdentity::ReadOnly { reason } = &desc.identity {
        return Err(AppError::Validation(reason.clone()));
    }
    no_repeats(changes.deletes.iter().map(|r| format!("{r:?}")), "deleted")?;
    no_repeats(
        changes.updates.iter().map(|u| format!("{:?}", u.row)),
        "updated",
    )?;

    let table = relation(desc);
    let mut statements = Vec::new();

    for row in &changes.deletes {
        let mut binder = Binder::new(inline);
        let (condition, name) = where_row(desc, row, &mut binder)?;
        let returning = if inline { "" } else { " RETURNING 1" };
        statements.push(Statement {
            kind: Kind::Delete,
            label: format!("delete row {name}"),
            sql: format!("DELETE FROM {table} WHERE {condition}{returning}"),
            params: binder.params,
        });
    }

    for update in &changes.updates {
        let cells = writes(desc, &update.values)?;
        if cells.is_empty() {
            return Err(AppError::Validation(
                "an update with nothing to change".into(),
            ));
        }
        let mut binder = Binder::new(inline);
        let assignments: Vec<String> = cells
            .iter()
            .map(|(column, value)| {
                format!(
                    "{} = {}",
                    quote_ident(&column.name),
                    binder.cell(value, column)
                )
            })
            .collect();
        let (condition, name) = where_row(desc, &update.row, &mut binder)?;
        let returning = if inline { "" } else { " RETURNING 1" };
        statements.push(Statement {
            kind: Kind::Update,
            label: format!("update row {name}"),
            sql: format!(
                "UPDATE {table} SET {} WHERE {condition}{returning}",
                assignments.join(", ")
            ),
            params: binder.params,
        });
    }

    for (n, insert) in changes.inserts.iter().enumerate() {
        let cells = writes(desc, &insert.values)?;
        let mut binder = Binder::new(inline);
        let body = if cells.is_empty() {
            "DEFAULT VALUES".to_owned()
        } else {
            let names: Vec<String> = cells.iter().map(|(c, _)| quote_ident(&c.name)).collect();
            let values: Vec<String> = cells.iter().map(|(c, v)| binder.cell(v, c)).collect();
            format!("({}) VALUES ({})", names.join(", "), values.join(", "))
        };
        let returning = if inline {
            String::new()
        } else {
            let columns: Vec<String> = desc
                .columns
                .iter()
                .map(|c| format!("{}::text", quote_ident(&c.name)))
                .collect();
            format!(" RETURNING {}", columns.join(", "))
        };
        statements.push(Statement {
            kind: Kind::Insert,
            label: format!("insert new row {}", n + 1),
            sql: format!("INSERT INTO {table} {body}{returning}"),
            params: binder.params,
        });
    }
    Ok(statements)
}

/// The SQL `apply_changes` would run, with values written in. For display only.
pub fn preview_sql(desc: &TableDescription, changes: &TableChanges) -> AppResult<String> {
    let statements = build(desc, changes, true)?;
    if statements.is_empty() {
        return Ok(String::new());
    }
    let mut lines = vec!["BEGIN;".to_owned()];
    lines.extend(statements.iter().map(|s| format!("{};", s.sql)));
    lines.push("COMMIT;".to_owned());
    Ok(lines.join("\n"))
}

pub async fn preview_changes(
    client: &Client,
    schema: &str,
    table: &str,
    changes: &TableChanges,
) -> AppResult<String> {
    let desc = introspect::describe_table(client, schema, table).await?;
    preview_sql(&desc, changes)
}

fn cells(row: &Row, width: usize) -> AppResult<Vec<Option<String>>> {
    Ok((0..width)
        .map(|i| row.try_get::<_, Option<String>>(i))
        .collect::<Result<Vec<_>, _>>()?)
}

/// Run `changes` in one transaction. On the first failure everything is rolled back and the
/// error says which change it was; nothing is written.
pub async fn apply_changes(
    client: &Client,
    schema: &str,
    table: &str,
    changes: &TableChanges,
) -> AppResult<ApplyResult> {
    let desc = introspect::describe_table(client, schema, table).await?;
    let statements = build(&desc, changes, false)?;
    if statements.is_empty() {
        return Ok(ApplyResult::default());
    }

    client.batch_execute("BEGIN").await?;
    let outcome = run_all(client, &desc, &statements).await;
    match outcome {
        Ok(result) => match client.batch_execute("COMMIT").await {
            Ok(()) => Ok(result),
            // A deferred constraint can still fail here.
            Err(e) => {
                let _ = client.batch_execute("ROLLBACK").await;
                Err(AppError::Change {
                    what: "Committing".into(),
                    source: Box::new(e.into()),
                })
            }
        },
        Err(e) => {
            // Also on a failed statement: an aborted transaction must not go back to the pool.
            let _ = client.batch_execute("ROLLBACK").await;
            Err(e)
        }
    }
}

async fn run_all(
    client: &Client,
    desc: &TableDescription,
    statements: &[Statement],
) -> AppResult<ApplyResult> {
    let mut result = ApplyResult::default();
    for (i, statement) in statements.iter().enumerate() {
        let what = format!(
            "Change {} of {} ({})",
            i + 1,
            statements.len(),
            statement.label
        );
        let fail = |source: AppError| AppError::Change {
            what: what.clone(),
            source: Box::new(source),
        };
        let params: Vec<(&(dyn ToSql + Sync), Type)> = statement
            .params
            .iter()
            .map(|value| (value as &(dyn ToSql + Sync), Type::TEXT))
            .collect();
        let rows = client
            .query_typed(&statement.sql, &params)
            .await
            .map_err(|e| fail(e.into()))?;

        match statement.kind {
            Kind::Insert => {
                let row = rows
                    .first()
                    .ok_or_else(|| fail(AppError::Internal("INSERT returned no row".into())))?;
                result
                    .inserted
                    .push(cells(row, desc.columns.len()).map_err(&fail)?);
            }
            Kind::Update | Kind::Delete => {
                match rows.len() {
                    1 => {}
                    0 => return Err(fail(AppError::Conflict("row changed or missing".into()))),
                    n => {
                        return Err(fail(AppError::Conflict(format!(
                            "it matched {n} rows, not 1"
                        ))));
                    }
                }
                if statement.kind == Kind::Update {
                    result.updated += 1;
                } else {
                    result.deleted += 1;
                }
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::changes::{RowInsert, RowUpdate};
    use crate::models::schema::ObjectKind;

    fn column(position: u16, name: &str, base_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            position,
            type_name: base_type.into(),
            base_type: base_type.into(),
            type_oid: 0,
            nullable: true,
            default_value: None,
            identity: None,
            generated: false,
            is_primary_key: false,
            comment: None,
            foreign_keys: Vec::new(),
        }
    }

    fn table(identity: RowIdentity) -> TableDescription {
        let mut id = column(1, "id", "bigint");
        id.identity = Some(ColumnIdentity::Always);
        let mut total = column(4, "total", "numeric");
        total.generated = true;
        TableDescription {
            schema: "public".into(),
            name: "users".into(),
            kind: ObjectKind::Table,
            comment: None,
            columns: vec![
                id,
                column(2, "na\"me", "character varying"),
                column(3, "born", "date"),
                total,
            ],
            identity,
        }
    }

    fn pk() -> RowIdentity {
        RowIdentity::PrimaryKey {
            columns: vec!["id".into()],
        }
    }

    fn key(id: &str) -> RowRef {
        RowRef::Key {
            columns: vec!["id".into()],
            values: vec![id.into()],
        }
    }

    fn text(value: &str) -> CellValue {
        CellValue::Value { text: value.into() }
    }

    fn update(row: RowRef, values: &[(&str, CellValue)]) -> RowUpdate {
        RowUpdate {
            row,
            values: values
                .iter()
                .map(|(k, v)| ((*k).to_owned(), v.clone()))
                .collect(),
        }
    }

    #[test]
    fn nothing_staged_builds_nothing() {
        let built = build(&table(pk()), &TableChanges::default(), false).unwrap();
        assert!(built.is_empty());
        assert_eq!(
            preview_sql(&table(pk()), &TableChanges::default()).unwrap(),
            ""
        );
    }

    #[test]
    fn an_update_binds_values_casts_them_and_keeps_column_order() {
        let changes = TableChanges {
            updates: vec![update(
                key("7"),
                // Inserted in the "wrong" order on purpose: the SQL follows the table.
                &[
                    ("born", CellValue::Null),
                    ("na\"me", text("O'Brien; DROP TABLE users; --")),
                ],
            )],
            ..Default::default()
        };
        let built = build(&table(pk()), &changes, false).unwrap();
        assert_eq!(built.len(), 1);
        assert_eq!(
            built[0].sql,
            "UPDATE \"public\".\"users\" SET \"na\"\"me\" = $1::text::character varying, \
             \"born\" = $2::text::date WHERE \"id\" = $3::text::bigint RETURNING 1"
        );
        assert_eq!(
            built[0].params,
            [
                Some("O'Brien; DROP TABLE users; --".to_owned()),
                None,
                Some("7".to_owned())
            ]
        );
        assert_eq!(built[0].label, "update row id = 7");
    }

    #[test]
    fn default_is_a_keyword_not_a_parameter() {
        let changes = TableChanges {
            updates: vec![update(key("1"), &[("born", CellValue::Default)])],
            ..Default::default()
        };
        let built = build(&table(pk()), &changes, false).unwrap();
        assert_eq!(
            built[0].sql,
            "UPDATE \"public\".\"users\" SET \"born\" = DEFAULT WHERE \"id\" = $1::text::bigint \
             RETURNING 1"
        );
        assert_eq!(built[0].params, [Some("1".to_owned())]);
    }

    #[test]
    fn deletes_run_first_then_updates_then_inserts() {
        let changes = TableChanges {
            updates: vec![update(key("2"), &[("born", text("2000-01-01"))])],
            inserts: vec![RowInsert {
                values: [("na\"me".to_owned(), text("New"))].into(),
            }],
            deletes: vec![key("1")],
        };
        let built = build(&table(pk()), &changes, false).unwrap();
        let kinds: Vec<_> = built.iter().map(|s| s.kind).collect();
        assert_eq!(kinds, [Kind::Delete, Kind::Update, Kind::Insert]);
        assert_eq!(
            built[0].sql,
            "DELETE FROM \"public\".\"users\" WHERE \"id\" = $1::text::bigint RETURNING 1"
        );
        assert_eq!(
            built[2].sql,
            "INSERT INTO \"public\".\"users\" (\"na\"\"me\") VALUES ($1::text::character varying) \
             RETURNING \"id\"::text, \"na\"\"me\"::text, \"born\"::text, \"total\"::text"
        );
    }

    #[test]
    fn an_empty_insert_uses_default_values() {
        let changes = TableChanges {
            inserts: vec![RowInsert {
                values: BTreeMap::new(),
            }],
            ..Default::default()
        };
        let built = build(&table(pk()), &changes, false).unwrap();
        assert!(
            built[0]
                .sql
                .starts_with("INSERT INTO \"public\".\"users\" DEFAULT VALUES RETURNING"),
            "{}",
            built[0].sql
        );
        assert!(built[0].params.is_empty());
    }

    #[test]
    fn ctid_rows_are_found_by_ctid() {
        let changes = TableChanges {
            deletes: vec![RowRef::Ctid {
                ctid: "(0,3)".into(),
            }],
            ..Default::default()
        };
        let built = build(&table(RowIdentity::Ctid), &changes, false).unwrap();
        assert_eq!(
            built[0].sql,
            "DELETE FROM \"public\".\"users\" WHERE ctid = $1::text::tid RETURNING 1"
        );
        assert_eq!(built[0].params, [Some("(0,3)".to_owned())]);
        assert_eq!(built[0].label, "delete row ctid (0,3)");
    }

    #[test]
    fn the_preview_writes_values_in_and_never_runs() {
        let changes = TableChanges {
            updates: vec![update(
                key("7"),
                &[("na\"me", text("O'Brien")), ("born", CellValue::Null)],
            )],
            deletes: vec![key("1")],
            ..Default::default()
        };
        assert_eq!(
            preview_sql(&table(pk()), &changes).unwrap(),
            "BEGIN;\n\
             DELETE FROM \"public\".\"users\" WHERE \"id\" = '1';\n\
             UPDATE \"public\".\"users\" SET \"na\"\"me\" = 'O''Brien', \"born\" = NULL \
             WHERE \"id\" = '7';\n\
             COMMIT;"
        );
    }

    #[test]
    fn bad_input_is_rejected_before_any_sql_exists() {
        let desc = table(pk());
        let bad: Vec<(&str, TableChanges)> = vec![
            (
                "unknown column",
                TableChanges {
                    updates: vec![update(key("1"), &[("nope", text("x"))])],
                    ..Default::default()
                },
            ),
            (
                "injection through a column name",
                TableChanges {
                    updates: vec![update(key("1"), &[("born\" = 1; --", text("x"))])],
                    ..Default::default()
                },
            ),
            (
                "identity column can't take a value",
                TableChanges {
                    updates: vec![update(key("1"), &[("id", text("9"))])],
                    ..Default::default()
                },
            ),
            (
                "generated column can't take NULL",
                TableChanges {
                    updates: vec![update(key("1"), &[("total", CellValue::Null)])],
                    ..Default::default()
                },
            ),
            (
                "update with nothing in it",
                TableChanges {
                    updates: vec![update(key("1"), &[])],
                    ..Default::default()
                },
            ),
            (
                "wrong key columns",
                TableChanges {
                    deletes: vec![RowRef::Key {
                        columns: vec!["born".into()],
                        values: vec!["2000-01-01".into()],
                    }],
                    ..Default::default()
                },
            ),
            (
                "ctid ref on a keyed table",
                TableChanges {
                    deletes: vec![RowRef::Ctid {
                        ctid: "(0,1)".into(),
                    }],
                    ..Default::default()
                },
            ),
            (
                "the same row deleted twice",
                TableChanges {
                    deletes: vec![key("1"), key("1")],
                    ..Default::default()
                },
            ),
            (
                "the same row updated twice",
                TableChanges {
                    updates: vec![
                        update(key("1"), &[("born", CellValue::Null)]),
                        update(key("1"), &[("born", CellValue::Null)]),
                    ],
                    ..Default::default()
                },
            ),
        ];
        for (what, changes) in bad {
            let err = build(&desc, &changes, false).unwrap_err();
            assert_eq!(err.code(), "VALIDATION", "{what}: {err:?}");
        }
    }

    #[test]
    fn identity_columns_and_generated_columns_still_accept_default() {
        let changes = TableChanges {
            inserts: vec![RowInsert {
                values: [
                    ("id".to_owned(), CellValue::Default),
                    ("total".to_owned(), CellValue::Default),
                ]
                .into(),
            }],
            ..Default::default()
        };
        assert!(build(&table(pk()), &changes, false).is_ok());
    }

    #[test]
    fn read_only_tables_refuse_everything() {
        let desc = table(RowIdentity::ReadOnly {
            reason: "Views can't be edited.".into(),
        });
        let changes = TableChanges {
            inserts: vec![RowInsert {
                values: BTreeMap::new(),
            }],
            ..Default::default()
        };
        let err = build(&desc, &changes, false).unwrap_err();
        assert_eq!(err.code(), "VALIDATION");
        assert_eq!(err.message(), "Views can't be edited.");
    }
}
