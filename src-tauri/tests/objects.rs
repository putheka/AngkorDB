//! Create, rename, truncate and drop, run for real in scratch databases (see `common`).

mod common;

use std::time::{Duration, Instant};

use angkordb_lib::db::objects::{apply, plan};
use angkordb_lib::db::query::run_script;
use angkordb_lib::db::session::Session;
use angkordb_lib::db::structure::table_structure;
use angkordb_lib::error::AppError;
use angkordb_lib::models::objects::{
    CreateTable, DropObject, NewTableColumn, ObjectOperation, RenameObject, TruncateTable,
};
use angkordb_lib::models::query::StatementOutcome;
use angkordb_lib::models::schema::{ColumnIdentity, ObjectKind};
use common::{Scratch, open_or_skip, run_all};

async fn scratch(label: &str, setup: &str) -> Option<(Session, Scratch, Session)> {
    let dev = open_or_skip().await?;
    let db = Scratch::create(&dev, label).await;
    let session = db.open().await;
    run_all(&session, setup, &[]).await.unwrap();
    Some((session, db, dev))
}

async fn run(session: &Session, op: ObjectOperation) -> angkordb_lib::error::AppResult<u32> {
    let client = session.meta().await.unwrap();
    apply(&client, &op, 5_000).await
}

async fn values(session: &Session, sql: &str) -> Vec<Vec<Option<String>>> {
    let run = run_script(session, "t", sql).await.unwrap();
    match &run.statements[0].outcome {
        StatementOutcome::Rows { rows, .. } => rows.clone(),
        other => panic!("{sql}: {other:?}"),
    }
}

fn column(name: &str, type_name: &str) -> NewTableColumn {
    NewTableColumn {
        name: name.into(),
        type_name: type_name.into(),
        nullable: true,
        default_value: None,
        identity: None,
        primary_key: false,
        comment: None,
    }
}

const SETUP: &str = r#"
CREATE TABLE users (id serial PRIMARY KEY, name text);
INSERT INTO users (name) VALUES ('a'), ('b'), ('c');
CREATE TABLE orders (id serial PRIMARY KEY, user_id integer REFERENCES users (id));
INSERT INTO orders (user_id) VALUES (1), (2);
CREATE VIEW user_names AS SELECT name FROM users;
"#;

#[tokio::test]
async fn a_new_table_has_its_identity_key_defaults_and_comments() {
    let Some((session, db, dev)) = scratch("create", "").await else {
        return;
    };
    let op = ObjectOperation::CreateTable(CreateTable {
        schema: "public".into(),
        name: "events".into(),
        comment: Some("What happened".into()),
        columns: vec![
            NewTableColumn {
                identity: Some(ColumnIdentity::Always),
                primary_key: true,
                nullable: false,
                ..column("id", "bigint")
            },
            NewTableColumn {
                nullable: false,
                comment: Some("Who".into()),
                ..column("name", "text")
            },
            NewTableColumn {
                nullable: false,
                default_value: Some("now()".into()),
                ..column("created_at", "timestamp with time zone")
            },
        ],
    });
    let statements = plan(&op).unwrap().len();
    assert_eq!(run(&session, op).await.unwrap() as usize, statements);

    let s = table_structure(&session.meta().await.unwrap(), "public", "events")
        .await
        .unwrap();
    assert_eq!(s.info.comment.as_deref(), Some("What happened"));
    let id = &s.columns[0];
    assert_eq!(id.identity, Some(ColumnIdentity::Always));
    assert!(id.is_primary_key && !id.nullable);
    assert_eq!(s.columns[1].comment.as_deref(), Some("Who"));
    assert_eq!(s.columns[2].default_value.as_deref(), Some("now()"));
    assert!(!s.columns[2].nullable);

    // It works as a table.
    run_all(
        &session,
        "INSERT INTO events (name) VALUES ('x'), ('y')",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        values(&session, "SELECT id::text FROM events ORDER BY id").await,
        [[Some("1".into())], [Some("2".into())]]
    );

    // Creating it again is an error, and nothing else happened.
    let again = run(
        &session,
        ObjectOperation::CreateTable(CreateTable {
            schema: "public".into(),
            name: "events".into(),
            comment: None,
            columns: vec![column("a", "text")],
        }),
    )
    .await
    .unwrap_err();
    assert!(matches!(again, AppError::Postgres(_)), "{again:?}");

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_failing_create_leaves_nothing_behind() {
    let Some((session, db, dev)) = scratch("failcreate", "").await else {
        return;
    };
    // The type does not exist: the server refuses, and the connection is usable again.
    let err = run(
        &session,
        ObjectOperation::CreateTable(CreateTable {
            schema: "public".into(),
            name: "half".into(),
            comment: Some("c".into()),
            columns: vec![column("a", "no_such_type")],
        }),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Postgres(_)), "{err:?}");
    assert_eq!(err.pg_code(), Some("42704"));
    assert_eq!(
        values(
            &session,
            "SELECT count(*)::text FROM pg_tables WHERE tablename = 'half'"
        )
        .await[0][0],
        Some("0".into())
    );
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn rename_changes_tables_and_views() {
    let Some((session, db, dev)) = scratch("rename", SETUP).await else {
        return;
    };
    run(
        &session,
        ObjectOperation::Rename(RenameObject {
            object_kind: ObjectKind::Table,
            schema: "public".into(),
            name: "users".into(),
            new_name: "Members".into(),
        }),
    )
    .await
    .unwrap();
    run(
        &session,
        ObjectOperation::Rename(RenameObject {
            object_kind: ObjectKind::View,
            schema: "public".into(),
            name: "user_names".into(),
            new_name: "member_names".into(),
        }),
    )
    .await
    .unwrap();
    // The view follows the table it reads; the foreign key follows too.
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM member_names").await[0][0],
        Some("3".into())
    );
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM \"Members\"").await[0][0],
        Some("3".into())
    );
    let orders = table_structure(&session.meta().await.unwrap(), "public", "orders")
        .await
        .unwrap();
    assert_eq!(
        orders
            .constraints
            .iter()
            .find(|c| c.references.is_some())
            .unwrap()
            .references
            .as_deref(),
        Some("public.\"Members\"")
    );
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn truncate_with_restart_identity_and_cascade() {
    let Some((session, db, dev)) = scratch("truncate", SETUP).await else {
        return;
    };
    let truncate = |restart, cascade| {
        ObjectOperation::Truncate(TruncateTable {
            schema: "public".into(),
            name: "users".into(),
            restart_identity: restart,
            cascade,
        })
    };
    // Another table points at it: PostgreSQL refuses without CASCADE, and nothing is emptied.
    let err = run(&session, truncate(false, false)).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("0A000"), "{err:?}");
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM users").await[0][0],
        Some("3".into())
    );

    run(&session, truncate(true, true)).await.unwrap();
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM users").await[0][0],
        Some("0".into())
    );
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM orders").await[0][0],
        Some("0".into())
    );
    // RESTART IDENTITY: the serial starts again at 1.
    run_all(&session, "INSERT INTO users (name) VALUES ('again')", &[])
        .await
        .unwrap();
    assert_eq!(
        values(&session, "SELECT id::text FROM users").await[0][0],
        Some("1".into())
    );

    // Without it, the sequence goes on (the earlier CASCADE restarted this one too).
    run_all(&session, "INSERT INTO users (name) VALUES ('b')", &[])
        .await
        .unwrap();
    run_all(
        &session,
        "INSERT INTO orders (user_id) VALUES (1), (1)",
        &[],
    )
    .await
    .unwrap();
    run(
        &session,
        ObjectOperation::Truncate(TruncateTable {
            schema: "public".into(),
            name: "orders".into(),
            restart_identity: false,
            cascade: false,
        }),
    )
    .await
    .unwrap();
    run_all(&session, "INSERT INTO orders (user_id) VALUES (1)", &[])
        .await
        .unwrap();
    assert_eq!(
        values(&session, "SELECT id::text FROM orders").await[0][0],
        Some("3".into())
    );

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn drop_needs_cascade_when_something_depends_on_it() {
    let Some((session, db, dev)) = scratch("drop", SETUP).await else {
        return;
    };
    let drop_users = |cascade| {
        ObjectOperation::Drop(DropObject {
            object_kind: ObjectKind::Table,
            schema: "public".into(),
            name: "users".into(),
            cascade,
        })
    };
    let err = run(&session, drop_users(false)).await.unwrap_err();
    assert_eq!(
        err.pg_code(),
        Some("2BP01"),
        "dependent_objects_still_exist: {err:?}"
    );

    run(&session, drop_users(true)).await.unwrap();
    let left = values(
        &session,
        "SELECT string_agg(relname, ',' ORDER BY relname) FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'v')",
    )
    .await;
    // The view that read it is gone with it; the table that pointed at it stays.
    assert_eq!(left[0][0], Some("orders".into()));

    run(
        &session,
        ObjectOperation::Drop(DropObject {
            object_kind: ObjectKind::Table,
            schema: "public".into(),
            name: "orders".into(),
            cascade: false,
        }),
    )
    .await
    .unwrap();
    // Dropping what is not there is an error.
    assert!(
        run(
            &session,
            ObjectOperation::Drop(DropObject {
                object_kind: ObjectKind::Table,
                schema: "public".into(),
                name: "orders".into(),
                cascade: false,
            })
        )
        .await
        .is_err()
    );
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_held_lock_makes_the_operation_fail_quickly() {
    let Some((session, db, dev)) = scratch("lock", SETUP).await else {
        return;
    };
    let holder = session.meta().await.unwrap();
    holder
        .batch_execute("BEGIN; LOCK TABLE users IN ACCESS EXCLUSIVE MODE")
        .await
        .unwrap();
    let client = session.meta().await.unwrap();
    let started = Instant::now();
    let err = apply(
        &client,
        &ObjectOperation::Rename(RenameObject {
            object_kind: ObjectKind::Table,
            schema: "public".into(),
            name: "users".into(),
            new_name: "people".into(),
        }),
        300,
    )
    .await
    .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(err.pg_code(), Some("55P03"), "{err:?}");
    holder.batch_execute("ROLLBACK").await.unwrap();
    drop(holder);
    drop(client);
    // The connection works again, and the table has its old name.
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM users").await[0][0],
        Some("3".into())
    );
    drop(session);
    db.drop_it(&dev).await;
}
