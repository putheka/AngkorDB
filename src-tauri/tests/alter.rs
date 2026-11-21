//! Changing the structure of a table, run for real in scratch databases (see `common`).

mod common;

use std::time::{Duration, Instant};

use angkordb_lib::db::alter::{apply, plan};
use angkordb_lib::db::query::run_script;
use angkordb_lib::db::session::Session;
use angkordb_lib::db::structure::table_structure;
use angkordb_lib::error::AppError;
use angkordb_lib::models::alter::{
    AddColumn, AlterColumn, CheckSpec, CommentChange, CreateIndex, DefaultChange, DropColumn,
    DropConstraint, DropIndex, ForeignKeySpec, IndexColumn, IndexMethod, KeySpec, RefAction,
    StructureChange,
};
use angkordb_lib::models::query::StatementOutcome;
use angkordb_lib::models::structure::{ConstraintKind, TableStructure};
use common::{Scratch, open_or_skip, run_all};

const SETUP: &str = r#"
CREATE TABLE users (id integer PRIMARY KEY, email text NOT NULL);
INSERT INTO users VALUES (1, 'a@x'), (2, 'b@x');
CREATE TABLE orders (
  id serial PRIMARY KEY, user_id integer, status text DEFAULT 'pending', total numeric(12, 2), note text
);
INSERT INTO orders (user_id, status, total, note) VALUES (1, '1', 10.5, 'n1'), (2, '2', 20, 'n2'), (1, '3', 30, NULL);
CREATE VIEW user_emails AS SELECT id, email FROM users;
"#;

/// A scratch database with the tables above, and a session on it.
async fn scratch(label: &str) -> Option<(Session, Scratch, Session)> {
    let dev = open_or_skip().await?;
    let db = Scratch::create(&dev, label).await;
    let session = db.open().await;
    run_all(&session, SETUP, &[]).await.unwrap();
    Some((dev, db, session)).map(|(dev, db, session)| (session, db, dev))
}

async fn structure(session: &Session, table: &str) -> TableStructure {
    table_structure(&session.meta().await.unwrap(), "public", table)
        .await
        .unwrap()
}

async fn apply_all(
    session: &Session,
    table: &str,
    changes: &[StructureChange],
) -> angkordb_lib::error::AppResult<angkordb_lib::models::alter::StructureApplyResult> {
    let client = session.meta().await.unwrap();
    apply(&client, "public", table, changes, 5_000).await
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

fn index(name: &str, columns: &[&str]) -> CreateIndex {
    CreateIndex {
        name: Some(name.into()),
        method: IndexMethod::Btree,
        columns: columns
            .iter()
            .map(|c| IndexColumn {
                text: (*c).into(),
                is_expression: false,
                descending: false,
            })
            .collect(),
        unique: false,
        where_clause: None,
        concurrently: false,
    }
}

async fn values(session: &Session, sql: &str) -> Vec<Vec<Option<String>>> {
    let run = run_script(session, "t", sql).await.unwrap();
    match &run.statements[0].outcome {
        StatementOutcome::Rows { rows, .. } => rows.clone(),
        other => panic!("{sql}: {other:?}"),
    }
}

#[tokio::test]
async fn every_operation_runs_and_leaves_what_the_preview_said() {
    let Some((session, db, dev)) = scratch("every").await else {
        return;
    };

    let changes = vec![
        StructureChange::AddColumn(AddColumn {
            nullable: false,
            default_value: Some("now()".into()),
            comment: Some("When it was done".into()),
            ..add("done_at", "timestamp with time zone")
        }),
        StructureChange::AlterColumn(AlterColumn {
            new_name: Some("state".into()),
            type_name: Some("integer".into()),
            using: Some("status::integer".into()),
            nullable: Some(false),
            default_value: Some(DefaultChange::Set {
                expression: "0".into(),
            }),
            comment: Some(CommentChange::Set {
                text: "Order state".into(),
            }),
            ..alter("status")
        }),
        StructureChange::AlterColumn(AlterColumn {
            type_name: Some("numeric(14,3)".into()),
            ..alter("total")
        }),
        StructureChange::DropColumn(DropColumn {
            column: "note".into(),
            cascade: false,
        }),
        StructureChange::CreateIndex(index("orders_user_idx", &["user_id"])),
        StructureChange::CreateIndex(CreateIndex {
            unique: true,
            where_clause: Some("state > 0".into()),
            ..index("orders_state_total", &["state", "total"])
        }),
        StructureChange::AddUnique(KeySpec {
            name: Some("orders_user_total".into()),
            columns: vec!["user_id".into(), "total".into()],
        }),
        StructureChange::AddCheck(CheckSpec {
            name: Some("total_positive".into()),
            expression: "total > 0".into(),
            not_valid: false,
        }),
        StructureChange::AddForeignKey(ForeignKeySpec {
            name: Some("orders_user_fk".into()),
            columns: vec!["user_id".into()],
            ref_schema: "public".into(),
            ref_table: "users".into(),
            ref_columns: vec!["id".into()],
            on_delete: RefAction::Cascade,
            on_update: RefAction::NoAction,
            not_valid: false,
        }),
    ];
    let planned = plan("public", "orders", &changes).unwrap();
    let result = apply_all(&session, "orders", &changes).await.unwrap();
    assert_eq!(result.statements as usize, planned.len());
    assert!(result.failed_concurrent.is_none());

    let s = structure(&session, "orders").await;
    let column = |name: &str| s.columns.iter().find(|c| c.name == name).unwrap();
    assert_eq!(column("done_at").type_name, "timestamp with time zone");
    assert!(!column("done_at").nullable);
    assert_eq!(column("done_at").default_value.as_deref(), Some("now()"));
    assert_eq!(
        column("done_at").comment.as_deref(),
        Some("When it was done")
    );
    assert!(
        s.columns
            .iter()
            .all(|c| c.name != "status" && c.name != "note")
    );
    let state = column("state");
    assert_eq!(state.type_name, "integer");
    assert!(!state.nullable);
    assert_eq!(state.default_value.as_deref(), Some("0"));
    assert_eq!(state.comment.as_deref(), Some("Order state"));
    assert_eq!(column("total").type_name, "numeric(14,3)");

    // The data went through the USING cast.
    assert_eq!(
        values(
            &session,
            "SELECT state, total::text FROM orders ORDER BY id"
        )
        .await,
        [
            [Some("1".into()), Some("10.500".into())],
            [Some("2".into()), Some("20.000".into())],
            [Some("3".into()), Some("30.000".into())],
        ]
    );

    let unique = s
        .indexes
        .iter()
        .find(|i| i.name == "orders_state_total")
        .unwrap();
    assert!(unique.unique && unique.partial);
    assert!(s.indexes.iter().any(|i| i.name == "orders_user_idx"));
    let kinds = |kind: ConstraintKind| s.constraints.iter().filter(|c| c.kind == kind).count();
    assert_eq!(kinds(ConstraintKind::Unique), 1);
    assert_eq!(kinds(ConstraintKind::Check), 1);
    let fk = s
        .constraints
        .iter()
        .find(|c| c.kind == ConstraintKind::ForeignKey)
        .unwrap();
    assert!(
        fk.definition.contains("ON DELETE CASCADE"),
        "{}",
        fk.definition
    );
    assert_eq!(fk.references.as_deref(), Some("public.users"));

    // And back out again.
    let undo = vec![
        StructureChange::DropIndex(DropIndex {
            name: "orders_user_idx".into(),
            concurrently: false,
        }),
        StructureChange::DropConstraint(DropConstraint {
            name: "orders_user_total".into(),
            cascade: false,
        }),
        StructureChange::DropColumn(DropColumn {
            column: "done_at".into(),
            cascade: false,
        }),
        StructureChange::AlterColumn(AlterColumn {
            nullable: Some(true),
            default_value: Some(DefaultChange::Drop),
            comment: Some(CommentChange::Clear),
            ..alter("state")
        }),
    ];
    apply_all(&session, "orders", &undo).await.unwrap();
    let s = structure(&session, "orders").await;
    assert!(s.indexes.iter().all(|i| i.name != "orders_user_idx"));
    assert!(s.constraints.iter().all(|c| c.name != "orders_user_total"));
    assert!(s.columns.iter().all(|c| c.name != "done_at"));
    let state = s.columns.iter().find(|c| c.name == "state").unwrap();
    assert!(state.nullable && state.default_value.is_none() && state.comment.is_none());

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_failing_change_rolls_the_whole_batch_back_and_says_which_one() {
    let Some((session, db, dev)) = scratch("atomic").await else {
        return;
    };
    let err = apply_all(
        &session,
        "orders",
        &[
            StructureChange::AddColumn(add("extra_a", "text")),
            // text -> integer has no implicit cast: the server refuses without a USING.
            StructureChange::AlterColumn(AlterColumn {
                type_name: Some("integer".into()),
                ..alter("status")
            }),
            StructureChange::AddColumn(add("extra_b", "text")),
        ],
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Change { .. }), "{err:?}");
    let message = err.message();
    assert!(
        message.starts_with("Change 2 of 3 (change type of column status) failed:"),
        "{message}"
    );
    assert!(message.ends_with("nothing was saved."), "{message}");

    let s = structure(&session, "orders").await;
    assert!(
        s.columns
            .iter()
            .all(|c| c.name != "extra_a" && c.name != "extra_b")
    );
    assert_eq!(
        s.columns
            .iter()
            .find(|c| c.name == "status")
            .unwrap()
            .type_name,
        "text"
    );
    // The connection is not left in a broken transaction.
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM orders").await[0][0],
        Some("3".into())
    );

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn concurrent_indexes_run_after_the_transaction_on_their_own() {
    let Some((session, db, dev)) = scratch("concurrent").await else {
        return;
    };

    // Both run: the column is added in the transaction, the index is built after it.
    let result = apply_all(
        &session,
        "orders",
        &[
            StructureChange::CreateIndex(CreateIndex {
                concurrently: true,
                ..index("orders_z_idx", &["z"])
            }),
            StructureChange::AddColumn(add("z", "integer")),
        ],
    )
    .await
    .unwrap();
    assert_eq!(result.statements, 2);
    assert!(result.failed_concurrent.is_none());
    let s = structure(&session, "orders").await;
    assert!(
        s.indexes
            .iter()
            .find(|i| i.name == "orders_z_idx")
            .unwrap()
            .valid
    );

    // The transaction part fails: the concurrent index is not built at all.
    let err = apply_all(
        &session,
        "orders",
        &[
            StructureChange::CreateIndex(CreateIndex {
                concurrently: true,
                ..index("orders_never", &["user_id"])
            }),
            StructureChange::DropColumn(DropColumn {
                column: "no_such_column".into(),
                cascade: false,
            }),
        ],
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Change { .. }), "{err:?}");
    let s = structure(&session, "orders").await;
    assert!(s.indexes.iter().all(|i| i.name != "orders_never"));

    // The concurrent part fails after the transaction was saved: the result says so, the column
    // is there, and the failed index is left invalid (which is how Postgres leaves it).
    let result = apply_all(
        &session,
        "orders",
        &[
            StructureChange::AddColumn(add("kept", "text")),
            StructureChange::CreateIndex(CreateIndex {
                unique: true,
                concurrently: true,
                // user_id has duplicates (1 appears twice).
                ..index("orders_user_unique", &["user_id"])
            }),
        ],
    )
    .await
    .unwrap();
    assert_eq!(result.statements, 1);
    let failed = result
        .failed_concurrent
        .expect("the unique index must fail");
    assert_eq!(failed.label, "create index orders_user_unique");
    assert_eq!(failed.error.pg_code.as_deref(), Some("23505"));
    let s = structure(&session, "orders").await;
    assert!(
        s.columns.iter().any(|c| c.name == "kept"),
        "the transaction was saved"
    );
    assert!(
        !s.indexes
            .iter()
            .find(|i| i.name == "orders_user_unique")
            .unwrap()
            .valid
    );
    // It can be cleaned up like any index.
    apply_all(
        &session,
        "orders",
        &[StructureChange::DropIndex(DropIndex {
            name: "orders_user_unique".into(),
            concurrently: true,
        })],
    )
    .await
    .unwrap();

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_lock_that_is_not_released_makes_the_change_fail_instead_of_waiting() {
    let Some((session, db, dev)) = scratch("lock").await else {
        return;
    };
    let holder = session.meta().await.unwrap();
    holder
        .batch_execute("BEGIN; LOCK TABLE orders IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();

    let client = session.meta().await.unwrap();
    let started = Instant::now();
    let err = apply(
        &client,
        "public",
        "orders",
        &[StructureChange::AddColumn(add("blocked", "text"))],
        300,
    )
    .await
    .unwrap_err();
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "waited {:?}",
        started.elapsed()
    );
    let AppError::Change { source, .. } = &err else {
        panic!("{err:?}");
    };
    assert_eq!(
        source.pg_code(),
        Some("55P03"),
        "lock_not_available: {err:?}"
    );

    // Not stuck in a transaction, and the change is not there.
    holder.batch_execute("ROLLBACK").await.unwrap();
    drop(holder);
    assert!(
        structure(&session, "orders")
            .await
            .columns
            .iter()
            .all(|c| c.name != "blocked")
    );
    apply(
        &client,
        "public",
        "orders",
        &[StructureChange::AddColumn(add("unblocked", "text"))],
        300,
    )
    .await
    .unwrap();

    drop(client);
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_view_cannot_be_changed_here() {
    let Some((session, db, dev)) = scratch("view").await else {
        return;
    };
    let err = apply_all(
        &session,
        "user_emails",
        &[StructureChange::AddColumn(add("x", "text"))],
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    assert!(err.message().contains("view"), "{}", err.message());
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn odd_names_and_defaults_with_text_in_them_are_kept_exactly() {
    let Some((session, db, dev)) = scratch("odd").await else {
        return;
    };
    apply_all(
        &session,
        "orders",
        &[
            StructureChange::AddColumn(AddColumn {
                default_value: Some("'it''s; -- fine /* really */'".into()),
                comment: Some("back\\slash '; DROP TABLE users; --".into()),
                ..add("we\"ird; \"name\"", "text")
            }),
            StructureChange::CreateIndex(CreateIndex {
                columns: vec![IndexColumn {
                    text: "lower(\"we\"\"ird; \"\"name\"\"\")".into(),
                    is_expression: true,
                    descending: false,
                }],
                ..index("idx \"odd\"", &[])
            }),
        ],
    )
    .await
    .unwrap();
    let s = structure(&session, "orders").await;
    let odd = s
        .columns
        .iter()
        .find(|c| c.name == "we\"ird; \"name\"")
        .unwrap();
    assert_eq!(
        odd.comment.as_deref(),
        Some("back\\slash '; DROP TABLE users; --")
    );
    assert!(
        odd.default_value
            .as_deref()
            .unwrap()
            .starts_with("'it''s; -- fine /* really */'")
    );
    assert!(s.indexes.iter().any(|i| i.name == "idx \"odd\""));
    // Nothing else happened: the users table is still there with its rows.
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM users").await[0][0],
        Some("2".into())
    );
    drop(session);
    db.drop_it(&dev).await;
}
