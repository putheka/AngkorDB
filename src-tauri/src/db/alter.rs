//! Turn staged structure changes into `ALTER TABLE` / `CREATE INDEX` / … and run them (ANG-37).
//!
//! [`plan`] is pure: the same list of statements is what the preview shows and what runs. Names
//! are quoted; the SQL the person typed (types, defaults, `USING`, `CHECK`, `WHERE`) goes in as
//! written after [`check_fragment`] has made sure it is one piece of SQL.
//!
//! [`apply`] runs the statements in one transaction with a lock timeout, so an `ALTER` can't wait
//! forever behind a long query. `CONCURRENTLY` statements can't run in a transaction: they run on
//! their own, after the transaction has committed, one at a time.

use tokio_postgres::Client;

use crate::db::rows::quote_ident;
use crate::db::script;
use crate::db::structure::literal;
use crate::error::{AppError, AppErrorPayload, AppResult};
use crate::models::alter::{
    AddColumn, AlterColumn, CheckSpec, CommentChange, ConcurrentFailure, CreateIndex,
    DefaultChange, DropColumn, DropConstraint, DropIndex, ForeignKeySpec, KeySpec,
    PlannedStatement, RefAction, StructureApplyResult, StructureChange, StructurePreview,
};

/// How long a statement waits for a lock before giving up.
pub const LOCK_TIMEOUT_MS: u32 = 10_000;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// SQL the person typed must be one piece: no `;` and no comment outside a string or a quoted
/// name, since either would change what the rest of the statement means.
pub fn check_fragment(text: &str, what: &str) -> AppResult<()> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            q @ ('\'' | '"') => {
                // A string or quoted name; the same quote twice is an escaped one.
                let backslashes = q == '\''
                    && i > 0
                    && matches!(chars[i - 1], 'e' | 'E')
                    && (i < 2 || !(chars[i - 2].is_alphanumeric() || chars[i - 2] == '_'));
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return Err(invalid(format!("{what}: a quote is never closed."))),
                        Some('\\') if backslashes => i += 2,
                        Some(c) if *c == q => {
                            if chars.get(i + 1) == Some(&q) {
                                i += 2;
                            } else {
                                i += 1;
                                break;
                            }
                        }
                        Some(_) => i += 1,
                    }
                }
            }
            ';' => return Err(invalid(format!("{what}: it can't contain a \";\"."))),
            '-' if chars.get(i + 1) == Some(&'-') => {
                return Err(invalid(format!(
                    "{what}: it can't contain a \"--\" comment."
                )));
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                return Err(invalid(format!(
                    "{what}: it can't contain a \"/* */\" comment."
                )));
            }
            _ => i += 1,
        }
    }
    Ok(())
}

/// A type as the person writes it: `numeric(10, 2)`, `timestamp with time zone`, `"My Type"`,
/// `public.status`, `int[]`. Nothing else is allowed in one.
pub(crate) fn check_type(text: &str) -> AppResult<()> {
    let allowed = |c: char| {
        c.is_alphanumeric()
            || matches!(c, '_' | '$' | '"' | '.' | ',' | '(' | ')' | '[' | ']' | ' ')
    };
    if text.trim().is_empty() {
        return Err(invalid("Give the column a type."));
    }
    if !text.chars().all(allowed) {
        return Err(invalid(format!(
            "\"{text}\" is not a type name: it can have letters, digits, spaces and _ $ \" . , ( ) [ ]."
        )));
    }
    check_fragment(text, "The type")
}

fn name(text: &str, what: &str) -> AppResult<String> {
    if text.trim().is_empty() {
        return Err(invalid(format!("Give the {what} a name.")));
    }
    Ok(quote_ident(text))
}

fn optional_name(text: &Option<String>) -> String {
    match text.as_deref().map(str::trim) {
        Some(n) if !n.is_empty() => format!(" CONSTRAINT {}", quote_ident(n)),
        _ => String::new(),
    }
}

fn columns(list: &[String], what: &str) -> AppResult<String> {
    if list.is_empty() || list.iter().any(|c| c.trim().is_empty()) {
        return Err(invalid(format!("Pick at least one column for the {what}.")));
    }
    Ok(list
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", "))
}

struct Planner<'a> {
    /// `"schema"."table"`
    table: String,
    schema: &'a str,
    out: Vec<PlannedStatement>,
    change: u32,
}

impl Planner<'_> {
    fn push(&mut self, label: impl Into<String>, sql: String, concurrent: bool, destructive: bool) {
        self.out.push(PlannedStatement {
            sql,
            label: label.into(),
            change: self.change,
            concurrent,
            destructive,
        });
    }

    fn alter(&mut self, label: String, action: String, destructive: bool) {
        let sql = format!("ALTER TABLE {} {action};", self.table);
        self.push(label, sql, false, destructive);
    }

    fn comment_on_column(&mut self, column: &str, comment: Option<&str>) {
        let target = format!("{}.{}", self.table, quote_ident(column));
        let text = comment.map_or_else(|| "NULL".to_owned(), literal);
        self.push(
            format!("comment on column {column}"),
            format!("COMMENT ON COLUMN {target} IS {text};"),
            false,
            false,
        );
    }

    fn add_column(&mut self, c: &AddColumn) -> AppResult<()> {
        let column = name(&c.name, "column")?;
        check_type(&c.type_name)?;
        let mut action = format!("ADD COLUMN {column} {}", c.type_name.trim());
        if let Some(default) = c.default_value.as_deref().filter(|d| !d.trim().is_empty()) {
            check_fragment(default, "The default")?;
            action.push_str(&format!(" DEFAULT {}", default.trim()));
        }
        if !c.nullable {
            action.push_str(" NOT NULL");
        }
        self.alter(format!("add column {}", c.name), action, false);
        if let Some(comment) = c.comment.as_deref().filter(|t| !t.is_empty()) {
            self.comment_on_column(&c.name, Some(comment));
        }
        Ok(())
    }

    fn alter_column(&mut self, c: &AlterColumn) -> AppResult<()> {
        let old = name(&c.column, "column")?;
        let renamed = c
            .new_name
            .as_deref()
            .filter(|n| *n != c.column)
            .map(str::to_owned);
        let mut touched = renamed.is_some();

        // Everything but the comment is written with the name the column has now: that is also
        // the name a `USING` expression is written with. The rename comes after those.
        let current = quote_ident(&c.column);
        let shown = c.column.as_str();

        // An old default that can't be cast to the new type would stop the change, so when the
        // type and the default both change the default is dropped first and set again after.
        let type_changes = c.type_name.is_some();
        if type_changes && matches!(c.default_value, Some(DefaultChange::Set { .. })) {
            self.alter(
                format!("alter column {shown}"),
                format!("ALTER COLUMN {current} DROP DEFAULT"),
                false,
            );
        }
        if let Some(type_name) = &c.type_name {
            check_type(type_name)?;
            let mut action = format!("ALTER COLUMN {current} TYPE {}", type_name.trim());
            if let Some(using) = c.using.as_deref().filter(|u| !u.trim().is_empty()) {
                check_fragment(using, "The USING expression")?;
                action.push_str(&format!(" USING {}", using.trim()));
            }
            self.alter(format!("change type of column {shown}"), action, false);
            touched = true;
        } else if c.using.as_deref().is_some_and(|u| !u.trim().is_empty()) {
            return Err(invalid("USING only goes with a change of type."));
        }
        match &c.default_value {
            Some(DefaultChange::Set { expression }) => {
                if expression.trim().is_empty() {
                    return Err(invalid("The default is empty: drop the default instead."));
                }
                check_fragment(expression, "The default")?;
                self.alter(
                    format!("set default of column {shown}"),
                    format!("ALTER COLUMN {current} SET DEFAULT {}", expression.trim()),
                    false,
                );
                touched = true;
            }
            Some(DefaultChange::Drop) => {
                self.alter(
                    format!("drop default of column {shown}"),
                    format!("ALTER COLUMN {current} DROP DEFAULT"),
                    false,
                );
                touched = true;
            }
            None => {}
        }
        if let Some(nullable) = c.nullable {
            let action = if nullable {
                "DROP NOT NULL"
            } else {
                "SET NOT NULL"
            };
            self.alter(
                format!("alter nullability of column {shown}"),
                format!("ALTER COLUMN {current} {action}"),
                false,
            );
            touched = true;
        }
        if let Some(new_name) = &renamed {
            let to = name(new_name, "column")?;
            self.alter(
                format!("rename column {shown}"),
                format!("RENAME COLUMN {old} TO {to}"),
                false,
            );
        }
        // The comment goes to the column under whatever name it has by now.
        let final_name = renamed.as_deref().unwrap_or(&c.column);
        match &c.comment {
            Some(CommentChange::Set { text }) => {
                self.comment_on_column(final_name, Some(text));
                touched = true;
            }
            Some(CommentChange::Clear) => {
                self.comment_on_column(final_name, None);
                touched = true;
            }
            None => {}
        }
        if !touched {
            return Err(invalid(format!(
                "Nothing to change in column {}.",
                c.column
            )));
        }
        Ok(())
    }

    fn drop_column(&mut self, c: &DropColumn) -> AppResult<()> {
        let column = name(&c.column, "column")?;
        let cascade = if c.cascade { " CASCADE" } else { "" };
        self.alter(
            format!("drop column {}", c.column),
            format!("DROP COLUMN {column}{cascade}"),
            true,
        );
        Ok(())
    }

    fn create_index(&mut self, c: &CreateIndex) -> AppResult<()> {
        if c.columns.is_empty() {
            return Err(invalid(
                "Pick at least one column or expression for the index.",
            ));
        }
        let mut items = Vec::new();
        for column in &c.columns {
            if column.text.trim().is_empty() {
                return Err(invalid("An index column is empty."));
            }
            let mut item = if column.is_expression {
                check_fragment(&column.text, "The index expression")?;
                format!("({})", column.text.trim())
            } else {
                quote_ident(column.text.trim())
            };
            if column.descending {
                item.push_str(" DESC");
            }
            items.push(item);
        }
        let mut sql = String::from("CREATE ");
        if c.unique {
            sql.push_str("UNIQUE ");
        }
        sql.push_str("INDEX ");
        if c.concurrently {
            sql.push_str("CONCURRENTLY ");
        }
        if let Some(index_name) = c.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            sql.push_str(&format!("{} ", quote_ident(index_name)));
        }
        sql.push_str(&format!(
            "ON {} USING {} ({})",
            self.table,
            c.method.sql(),
            items.join(", ")
        ));
        if let Some(predicate) = c.where_clause.as_deref().filter(|w| !w.trim().is_empty()) {
            check_fragment(predicate, "The WHERE of the index")?;
            sql.push_str(&format!(" WHERE {}", predicate.trim()));
        }
        sql.push(';');
        let label = match c.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => format!("create index {n}"),
            None => "create index".to_owned(),
        };
        self.push(label, sql, c.concurrently, false);
        Ok(())
    }

    fn drop_index(&mut self, c: &DropIndex) -> AppResult<()> {
        let index = format!("{}.{}", quote_ident(self.schema), name(&c.name, "index")?);
        let concurrently = if c.concurrently { "CONCURRENTLY " } else { "" };
        self.push(
            format!("drop index {}", c.name),
            format!("DROP INDEX {concurrently}{index};"),
            c.concurrently,
            true,
        );
        Ok(())
    }

    fn add_key(&mut self, spec: &KeySpec, what: &str, sql: &str) -> AppResult<()> {
        let list = columns(&spec.columns, what)?;
        self.alter(
            format!("add {what}"),
            format!("ADD{} {sql} ({list})", optional_name(&spec.name)),
            false,
        );
        Ok(())
    }

    fn add_check(&mut self, spec: &CheckSpec) -> AppResult<()> {
        if spec.expression.trim().is_empty() {
            return Err(invalid("Write the condition of the check."));
        }
        check_fragment(&spec.expression, "The check")?;
        let not_valid = if spec.not_valid { " NOT VALID" } else { "" };
        self.alter(
            "add check constraint".into(),
            format!(
                "ADD{} CHECK ({}){not_valid}",
                optional_name(&spec.name),
                spec.expression.trim()
            ),
            false,
        );
        Ok(())
    }

    fn add_foreign_key(&mut self, spec: &ForeignKeySpec) -> AppResult<()> {
        let local = columns(&spec.columns, "foreign key")?;
        let remote = columns(&spec.ref_columns, "foreign key (the columns it points at)")?;
        if spec.columns.len() != spec.ref_columns.len() {
            return Err(invalid(
                "A foreign key needs as many columns on the other table as on this one.",
            ));
        }
        let target = format!(
            "{}.{}",
            name(&spec.ref_schema, "schema")?,
            name(&spec.ref_table, "table")?
        );
        let mut action = format!(
            "ADD{} FOREIGN KEY ({local}) REFERENCES {target} ({remote})",
            optional_name(&spec.name)
        );
        for (when, what) in [("DELETE", spec.on_delete), ("UPDATE", spec.on_update)] {
            if what != RefAction::NoAction {
                action.push_str(&format!(" ON {when} {}", what.sql()));
            }
        }
        if spec.not_valid {
            action.push_str(" NOT VALID");
        }
        self.alter("add foreign key".into(), action, false);
        Ok(())
    }

    fn drop_constraint(&mut self, c: &DropConstraint) -> AppResult<()> {
        let constraint = name(&c.name, "constraint")?;
        let cascade = if c.cascade { " CASCADE" } else { "" };
        self.alter(
            format!("drop constraint {}", c.name),
            format!("DROP CONSTRAINT {constraint}{cascade}"),
            true,
        );
        Ok(())
    }
}

/// The statements for `changes`, in the order they were staged.
pub fn plan(
    schema: &str,
    table: &str,
    changes: &[StructureChange],
) -> AppResult<Vec<PlannedStatement>> {
    if schema.is_empty() || table.is_empty() {
        return Err(invalid("Which table?"));
    }
    let mut planner = Planner {
        table: format!("{}.{}", quote_ident(schema), quote_ident(table)),
        schema,
        out: Vec::new(),
        change: 0,
    };
    for (i, change) in changes.iter().enumerate() {
        planner.change = u32::try_from(i + 1).unwrap_or(u32::MAX);
        match change {
            StructureChange::AddColumn(c) => planner.add_column(c),
            StructureChange::AlterColumn(c) => planner.alter_column(c),
            StructureChange::DropColumn(c) => planner.drop_column(c),
            StructureChange::CreateIndex(c) => planner.create_index(c),
            StructureChange::DropIndex(c) => planner.drop_index(c),
            StructureChange::AddPrimaryKey(c) => planner.add_key(c, "primary key", "PRIMARY KEY"),
            StructureChange::AddUnique(c) => planner.add_key(c, "unique constraint", "UNIQUE"),
            StructureChange::AddCheck(c) => planner.add_check(c),
            StructureChange::AddForeignKey(c) => planner.add_foreign_key(c),
            StructureChange::DropConstraint(c) => planner.drop_constraint(c),
        }
        .map_err(|e| match e {
            AppError::Validation(message) => {
                invalid(format!("Change {} of {}: {message}", i + 1, changes.len()))
            }
            other => other,
        })?;
    }
    // Each statement has to stay one statement, whatever went into it.
    for statement in &planner.out {
        if script::split(&statement.sql).len() != 1 {
            return Err(invalid(format!(
                "Change {}: that would run as more than one statement.",
                statement.change
            )));
        }
    }
    Ok(planner.out)
}

/// The plan, and the same as text to read.
pub fn preview(
    schema: &str,
    table: &str,
    changes: &[StructureChange],
) -> AppResult<StructurePreview> {
    let statements = plan(schema, table, changes)?;
    let sql = preview_text(&statements);
    Ok(StructurePreview { statements, sql })
}

/// The transaction's statements, then the ones that can't be in it.
pub fn preview_text(statements: &[PlannedStatement]) -> String {
    let mut parts = Vec::new();
    let inside: Vec<&str> = statements
        .iter()
        .filter(|s| !s.concurrent)
        .map(|s| s.sql.as_str())
        .collect();
    if !inside.is_empty() {
        parts.push(format!(
            "-- In one transaction: all or nothing.\n{}",
            inside.join("\n")
        ));
    }
    let outside: Vec<&str> = statements
        .iter()
        .filter(|s| s.concurrent)
        .map(|s| s.sql.as_str())
        .collect();
    if !outside.is_empty() {
        parts.push(format!(
            "-- CONCURRENTLY can't run inside a transaction. These run on their own, one after\n-- the other, once the transaction above is saved. If one fails, the rest is still saved.\n{}",
            outside.join("\n")
        ));
    }
    parts.join("\n\n")
}

/// Run the changes: the transactional ones in one transaction, then each `CONCURRENTLY` one.
pub async fn apply(
    client: &Client,
    schema: &str,
    table: &str,
    changes: &[StructureChange],
    lock_timeout_ms: u32,
) -> AppResult<StructureApplyResult> {
    let statements = plan(schema, table, changes)?;
    if statements.is_empty() {
        return Ok(StructureApplyResult::default());
    }
    // Views and the like are changed with other statements; say so instead of failing oddly. This
    // reads `pg_class` only: anything that opens the table itself would wait behind a lock
    // with no timeout, which is what `lock_timeout` below is there to prevent.
    let kind: Option<String> = client
        .query_opt(
            "SELECT c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await?
        .map(|row| row.get(0));
    match kind.as_deref() {
        None => return Err(AppError::NotFound(format!("table {schema}.{table}"))),
        Some("r" | "p" | "f") => {}
        Some(_) => {
            return Err(invalid(
                "The structure of a view can't be changed here: change its SQL instead.",
            ));
        }
    }

    let (outside, inside): (Vec<_>, Vec<_>) = statements.iter().partition(|s| s.concurrent);
    let mut ran = 0u32;

    if !inside.is_empty() {
        client
            .batch_execute(&format!(
                "BEGIN; SET LOCAL lock_timeout = {lock_timeout_ms}"
            ))
            .await?;
        for statement in &inside {
            if let Err(e) = client.batch_execute(&statement.sql).await {
                // An aborted transaction must not go back to the pool.
                let _ = client.batch_execute("ROLLBACK").await;
                return Err(AppError::Change {
                    what: format!(
                        "Change {} of {} ({})",
                        statement.change,
                        changes.len(),
                        statement.label
                    ),
                    source: Box::new(e.into()),
                });
            }
            ran += 1;
        }
        if let Err(e) = client.batch_execute("COMMIT").await {
            let _ = client.batch_execute("ROLLBACK").await;
            return Err(AppError::Change {
                what: "Committing".into(),
                source: Box::new(e.into()),
            });
        }
    }

    for statement in outside {
        if let Err(e) = client.batch_execute(&statement.sql).await {
            return Ok(StructureApplyResult {
                statements: ran,
                failed_concurrent: Some(ConcurrentFailure {
                    label: statement.label.clone(),
                    sql: statement.sql.clone(),
                    error: AppErrorPayload::from(&AppError::from(e)),
                }),
            });
        }
        ran += 1;
    }
    Ok(StructureApplyResult {
        statements: ran,
        failed_concurrent: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::alter::{IndexColumn, IndexMethod};

    fn sql(changes: Vec<StructureChange>) -> Vec<String> {
        plan("public", "orders", &changes)
            .unwrap()
            .into_iter()
            .map(|s| s.sql)
            .collect()
    }

    fn add(name: &str, type_name: &str) -> AddColumn {
        AddColumn {
            name: name.into(),
            type_name: type_name.into(),
            nullable: true,
            default_value: None,
            comment: None,
        }
    }

    fn alter(column: &str) -> AlterColumn {
        AlterColumn {
            column: column.into(),
            new_name: None,
            type_name: None,
            using: None,
            nullable: None,
            default_value: None,
            comment: None,
        }
    }

    #[test]
    fn a_new_column_with_default_not_null_and_comment() {
        let out = sql(vec![StructureChange::AddColumn(AddColumn {
            nullable: false,
            default_value: Some("now()".into()),
            comment: Some("When it's done".into()),
            ..add("done_at", "timestamp with time zone")
        })]);
        assert_eq!(
            out,
            [
                "ALTER TABLE \"public\".\"orders\" ADD COLUMN \"done_at\" timestamp with time zone DEFAULT now() NOT NULL;",
                "COMMENT ON COLUMN \"public\".\"orders\".\"done_at\" IS 'When it''s done';",
            ]
        );
    }

    #[test]
    fn altering_a_column_changes_type_default_nullability_then_renames_then_comments() {
        let out = sql(vec![StructureChange::AlterColumn(AlterColumn {
            new_name: Some("state".into()),
            type_name: Some("integer".into()),
            using: Some("status::integer".into()),
            nullable: Some(false),
            default_value: Some(DefaultChange::Set {
                expression: "0".into(),
            }),
            comment: Some(CommentChange::Set {
                text: "State".into(),
            }),
            ..alter("status")
        })]);
        assert_eq!(
            out,
            [
                // The old default could not be cast: it goes before the type changes.
                "ALTER TABLE \"public\".\"orders\" ALTER COLUMN \"status\" DROP DEFAULT;",
                // USING is written with the name the column has until it is renamed.
                "ALTER TABLE \"public\".\"orders\" ALTER COLUMN \"status\" TYPE integer USING status::integer;",
                "ALTER TABLE \"public\".\"orders\" ALTER COLUMN \"status\" SET DEFAULT 0;",
                "ALTER TABLE \"public\".\"orders\" ALTER COLUMN \"status\" SET NOT NULL;",
                "ALTER TABLE \"public\".\"orders\" RENAME COLUMN \"status\" TO \"state\";",
                // The comment is for the column under its new name.
                "COMMENT ON COLUMN \"public\".\"orders\".\"state\" IS 'State';",
            ]
        );
    }

    #[test]
    fn dropping_a_default_or_a_comment_and_allowing_null() {
        let out = sql(vec![StructureChange::AlterColumn(AlterColumn {
            nullable: Some(true),
            default_value: Some(DefaultChange::Drop),
            comment: Some(CommentChange::Clear),
            ..alter("note")
        })]);
        assert_eq!(
            out,
            [
                "ALTER TABLE \"public\".\"orders\" ALTER COLUMN \"note\" DROP DEFAULT;",
                "ALTER TABLE \"public\".\"orders\" ALTER COLUMN \"note\" DROP NOT NULL;",
                "COMMENT ON COLUMN \"public\".\"orders\".\"note\" IS NULL;",
            ]
        );
    }

    #[test]
    fn dropping_a_column_is_marked_destructive() {
        let planned = plan(
            "public",
            "orders",
            &[StructureChange::DropColumn(DropColumn {
                column: "note".into(),
                cascade: true,
            })],
        )
        .unwrap();
        assert_eq!(planned.len(), 1);
        assert_eq!(
            planned[0].sql,
            "ALTER TABLE \"public\".\"orders\" DROP COLUMN \"note\" CASCADE;"
        );
        assert!(planned[0].destructive && !planned[0].concurrent);
    }

    fn column(text: &str) -> IndexColumn {
        IndexColumn {
            text: text.into(),
            is_expression: false,
            descending: false,
        }
    }

    #[test]
    fn indexes_columns_expressions_partial_unique_and_concurrent() {
        let planned = plan(
            "public",
            "orders",
            &[StructureChange::CreateIndex(CreateIndex {
                name: Some("orders_lookup".into()),
                method: IndexMethod::Gin,
                columns: vec![
                    column("tags"),
                    IndexColumn {
                        text: "lower(note)".into(),
                        is_expression: true,
                        descending: true,
                    },
                ],
                unique: true,
                where_clause: Some("status <> 'cancelled'".into()),
                concurrently: true,
            })],
        )
        .unwrap();
        assert_eq!(
            planned[0].sql,
            "CREATE UNIQUE INDEX CONCURRENTLY \"orders_lookup\" ON \"public\".\"orders\" USING gin (\"tags\", (lower(note)) DESC) WHERE status <> 'cancelled';"
        );
        assert!(planned[0].concurrent && !planned[0].destructive);

        // Without a name the server picks one.
        let out = sql(vec![StructureChange::CreateIndex(CreateIndex {
            name: None,
            method: IndexMethod::Btree,
            columns: vec![column("user_id")],
            unique: false,
            where_clause: None,
            concurrently: false,
        })]);
        assert_eq!(
            out,
            ["CREATE INDEX ON \"public\".\"orders\" USING btree (\"user_id\");"]
        );
    }

    #[test]
    fn dropping_an_index_names_it_in_the_tables_schema() {
        let out = sql(vec![StructureChange::DropIndex(DropIndex {
            name: "orders_user_id_idx".into(),
            concurrently: false,
        })]);
        assert_eq!(out, ["DROP INDEX \"public\".\"orders_user_id_idx\";"]);
        let planned = plan(
            "public",
            "orders",
            &[StructureChange::DropIndex(DropIndex {
                name: "x".into(),
                concurrently: true,
            })],
        )
        .unwrap();
        assert_eq!(planned[0].sql, "DROP INDEX CONCURRENTLY \"public\".\"x\";");
        assert!(planned[0].concurrent && planned[0].destructive);
    }

    #[test]
    fn constraints_of_every_kind() {
        let out = sql(vec![
            StructureChange::AddPrimaryKey(KeySpec {
                name: None,
                columns: vec!["a".into(), "b".into()],
            }),
            StructureChange::AddUnique(KeySpec {
                name: Some("orders_code_key".into()),
                columns: vec!["code".into()],
            }),
            StructureChange::AddCheck(CheckSpec {
                name: Some("positive".into()),
                expression: "total > 0".into(),
                not_valid: true,
            }),
            StructureChange::AddForeignKey(ForeignKeySpec {
                name: Some("orders_user_fk".into()),
                columns: vec!["user_id".into()],
                ref_schema: "public".into(),
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
                on_delete: RefAction::Cascade,
                on_update: RefAction::SetNull,
                not_valid: false,
            }),
            StructureChange::AddForeignKey(ForeignKeySpec {
                name: None,
                columns: vec!["x".into(), "y".into()],
                ref_schema: "billing".into(),
                ref_table: "t".into(),
                ref_columns: vec!["a".into(), "b".into()],
                on_delete: RefAction::NoAction,
                on_update: RefAction::NoAction,
                not_valid: true,
            }),
            StructureChange::DropConstraint(DropConstraint {
                name: "old_check".into(),
                cascade: false,
            }),
        ]);
        assert_eq!(
            out,
            [
                "ALTER TABLE \"public\".\"orders\" ADD PRIMARY KEY (\"a\", \"b\");",
                "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"orders_code_key\" UNIQUE (\"code\");",
                "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"positive\" CHECK (total > 0) NOT VALID;",
                "ALTER TABLE \"public\".\"orders\" ADD CONSTRAINT \"orders_user_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"public\".\"users\" (\"id\") ON DELETE CASCADE ON UPDATE SET NULL;",
                "ALTER TABLE \"public\".\"orders\" ADD FOREIGN KEY (\"x\", \"y\") REFERENCES \"billing\".\"t\" (\"a\", \"b\") NOT VALID;",
                "ALTER TABLE \"public\".\"orders\" DROP CONSTRAINT \"old_check\";",
            ]
        );
    }

    #[test]
    fn odd_names_are_quoted() {
        let out = sql(vec![StructureChange::AddColumn(add(
            "we\"ird; name",
            "text",
        ))]);
        assert_eq!(
            out,
            ["ALTER TABLE \"public\".\"orders\" ADD COLUMN \"we\"\"ird; name\" text;"]
        );
        let out = plan(
            "My Schema",
            "User\"s",
            &[StructureChange::AddColumn(add("order", "text"))],
        )
        .unwrap();
        assert_eq!(
            out[0].sql,
            "ALTER TABLE \"My Schema\".\"User\"\"s\" ADD COLUMN \"order\" text;"
        );
    }

    #[test]
    fn typed_sql_cannot_become_another_statement() {
        for bad in [
            "1; DROP TABLE users",
            "1 -- and the rest is gone",
            "1 /* x */",
            "'unclosed",
            "now() ; SELECT 1",
        ] {
            let err = plan(
                "public",
                "orders",
                &[StructureChange::AddColumn(AddColumn {
                    default_value: Some(bad.into()),
                    ..add("a", "text")
                })],
            )
            .unwrap_err();
            assert!(matches!(err, AppError::Validation(_)), "{bad}: {err:?}");
        }
        // In a string or a quoted name they are just text.
        assert!(
            plan(
                "public",
                "orders",
                &[StructureChange::AddColumn(AddColumn {
                    default_value: Some("'a; b -- c /* d */'".into()),
                    ..add("a", "text")
                })]
            )
            .is_ok()
        );
        for bad_type in [
            "text; DROP TABLE users",
            "text --",
            "int'",
            "numeric(1,2) x;y",
        ] {
            assert!(
                plan(
                    "public",
                    "orders",
                    &[StructureChange::AddColumn(add("a", bad_type))]
                )
                .is_err(),
                "{bad_type}"
            );
        }
        for ok_type in [
            "numeric(10, 2)",
            "timestamp with time zone",
            "\"My Type\"",
            "public.status",
            "int[]",
            "text[][]",
        ] {
            assert!(
                plan(
                    "public",
                    "orders",
                    &[StructureChange::AddColumn(add("a", ok_type))]
                )
                .is_ok(),
                "{ok_type}"
            );
        }
    }

    #[test]
    fn mistakes_are_reported_with_which_change_they_are() {
        let err = plan(
            "public",
            "orders",
            &[
                StructureChange::AddColumn(add("a", "text")),
                StructureChange::AddColumn(add("  ", "text")),
            ],
        )
        .unwrap_err();
        assert_eq!(err.message(), "Change 2 of 2: Give the column a name.");

        for change in [
            StructureChange::AlterColumn(alter("a")),
            StructureChange::AlterColumn(AlterColumn {
                using: Some("a::int".into()),
                ..alter("a")
            }),
            StructureChange::CreateIndex(CreateIndex {
                name: None,
                method: IndexMethod::Btree,
                columns: vec![],
                unique: false,
                where_clause: None,
                concurrently: false,
            }),
            StructureChange::AddUnique(KeySpec {
                name: None,
                columns: vec![],
            }),
            StructureChange::AddCheck(CheckSpec {
                name: None,
                expression: " ".into(),
                not_valid: false,
            }),
            StructureChange::AddForeignKey(ForeignKeySpec {
                name: None,
                columns: vec!["a".into(), "b".into()],
                ref_schema: "public".into(),
                ref_table: "t".into(),
                ref_columns: vec!["id".into()],
                on_delete: RefAction::NoAction,
                on_update: RefAction::NoAction,
                not_valid: false,
            }),
            StructureChange::DropColumn(DropColumn {
                column: String::new(),
                cascade: false,
            }),
        ] {
            assert!(
                plan("public", "orders", std::slice::from_ref(&change)).is_err(),
                "{change:?}"
            );
        }
        assert!(plan("public", "orders", &[]).unwrap().is_empty());
    }

    #[test]
    fn the_preview_puts_the_transaction_first_and_explains_concurrent_ones() {
        let preview = preview(
            "public",
            "orders",
            &[
                StructureChange::CreateIndex(CreateIndex {
                    name: Some("a".into()),
                    method: IndexMethod::Btree,
                    columns: vec![column("x")],
                    unique: false,
                    where_clause: None,
                    concurrently: true,
                }),
                StructureChange::AddColumn(add("n", "text")),
            ],
        )
        .unwrap();
        assert_eq!(preview.statements.len(), 2);
        let transaction = preview.sql.find("In one transaction").unwrap();
        let add_at = preview.sql.find("ADD COLUMN").unwrap();
        let concurrent = preview.sql.find("CREATE INDEX CONCURRENTLY").unwrap();
        assert!(
            transaction < add_at && add_at < concurrent,
            "{}",
            preview.sql
        );
        assert!(
            preview
                .sql
                .contains("CONCURRENTLY can't run inside a transaction")
        );
    }
}
