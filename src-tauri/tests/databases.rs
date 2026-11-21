//! Creating and dropping databases and schemas, for real (see `common`). Databases made here are
//! named like the scratch ones, so a run that was killed is cleaned up by the next one.

mod common;

use angkordb_lib::db::introspect;
use angkordb_lib::db::objects::{apply, database_connections, database_options};
use angkordb_lib::db::query::run_script;
use angkordb_lib::db::session::Session;
use angkordb_lib::error::AppError;
use angkordb_lib::models::objects::{
    CreateDatabase, CreateSchema, DropDatabase, DropSchema, ObjectOperation, RenameSchema,
};
use angkordb_lib::models::query::StatementOutcome;
use common::{DEV_PASSWORD, Scratch, dev_config, open_or_skip, run_all};

async fn schema_names(session: &Session) -> Vec<String> {
    introspect::list_schemas(&session.meta().await.unwrap(), false)
        .await
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect()
}

fn name(label: &str) -> String {
    format!("angkordb_ddl_{}_{label}", std::process::id())
}

async fn run(session: &Session, op: ObjectOperation) -> angkordb_lib::error::AppResult<u32> {
    let client = session.meta().await.unwrap();
    apply(&client, &op, 5_000).await
}

async fn exists(session: &Session, database: &str) -> bool {
    let client = session.meta().await.unwrap();
    !client
        .query("SELECT 1 FROM pg_database WHERE datname = $1", &[&database])
        .await
        .unwrap()
        .is_empty()
}

async fn values(session: &Session, sql: &str) -> Vec<Vec<Option<String>>> {
    let run = run_script(session, "t", sql).await.unwrap();
    match &run.statements[0].outcome {
        StatementOutcome::Rows { rows, .. } => rows.clone(),
        other => panic!("{sql}: {other:?}"),
    }
}

#[tokio::test]
async fn a_database_is_created_with_its_owner_template_and_encoding() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let new = name("create");
    let _ = run(
        &dev,
        ObjectOperation::DropDatabase(DropDatabase {
            name: new.clone(),
            force: true,
        }),
    )
    .await;

    let options = {
        let client = dev.meta().await.unwrap();
        database_options(&client).await.unwrap()
    };
    assert_eq!(options.current_role, "angkor");
    assert!(options.roles.contains(&"angkor".to_owned()));
    assert!(options.templates.contains(&"template0".to_owned()));
    assert!(options.templates.contains(&"angkordb_dev".to_owned()));
    assert!(options.encodings.contains(&"UTF8".to_owned()));
    assert!(options.encodings.contains(&"LATIN1".to_owned()));

    let create = ObjectOperation::CreateDatabase(CreateDatabase {
        name: new.clone(),
        owner: Some("angkor".into()),
        template: Some("template0".into()),
        encoding: Some("UTF8".into()),
    });
    assert_eq!(run(&dev, create.clone()).await.unwrap(), 1);
    assert!(exists(&dev, &new).await);
    let facts = values(
        &dev,
        &format!(
            "SELECT pg_get_userbyid(datdba), pg_encoding_to_char(encoding)
               FROM pg_database WHERE datname = '{new}'"
        ),
    )
    .await;
    assert_eq!(facts[0], [Some("angkor".into()), Some("UTF8".into())]);

    // The sidebar's own list sees it.
    let listed = introspect::list_databases(&dev.meta().await.unwrap())
        .await
        .unwrap();
    assert!(listed.iter().any(|d| d.name == new));

    // Again: PostgreSQL says it exists. The connection is not left in a transaction.
    let err = run(&dev, create).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("42P04"), "{err:?}");
    assert_eq!(values(&dev, "SELECT 1::text").await[0][0], Some("1".into()));

    run(
        &dev,
        ObjectOperation::DropDatabase(DropDatabase {
            name: new.clone(),
            force: false,
        }),
    )
    .await
    .unwrap();
    assert!(!exists(&dev, &new).await);
}

#[tokio::test]
async fn a_database_in_use_is_refused_unless_forced() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let target = Scratch::create(&dev, "busy").await;
    let user = target.open().await;
    // Someone is connected to it.
    assert_eq!(
        values(&user, "SELECT 1::text").await[0][0],
        Some("1".into())
    );
    let busy = {
        let client = dev.meta().await.unwrap();
        database_connections(&client, &target.name).await.unwrap()
    };
    assert!(busy >= 1, "{busy} connections");

    let drop_it = |force| {
        ObjectOperation::DropDatabase(DropDatabase {
            name: target.name.clone(),
            force,
        })
    };
    let err = run(&dev, drop_it(false)).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("55006"), "object_in_use: {err:?}");
    assert!(exists(&dev, &target.name).await);

    run(&dev, drop_it(true)).await.unwrap();
    assert!(!exists(&dev, &target.name).await);
    assert_eq!(
        {
            let client = dev.meta().await.unwrap();
            database_connections(&client, &target.name).await.unwrap()
        },
        0
    );
    drop(user);
}

#[tokio::test]
async fn the_database_you_are_in_cannot_be_dropped() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let target = Scratch::create(&dev, "current").await;
    let inside = target.open().await;
    let err = run(
        &inside,
        ObjectOperation::DropDatabase(DropDatabase {
            name: target.name.clone(),
            force: true,
        }),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    assert!(
        err.message().contains("switch to another"),
        "{}",
        err.message()
    );
    assert!(exists(&dev, &target.name).await);
    drop(inside);
    target.drop_it(&dev).await;
}

#[tokio::test]
async fn schemas_are_created_renamed_and_dropped() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let target = Scratch::create(&dev, "schemas").await;
    let session = target.open().await;

    run(
        &session,
        ObjectOperation::CreateSchema(CreateSchema {
            name: "billing".into(),
            owner: Some("angkor".into()),
        }),
    )
    .await
    .unwrap();
    run_all(&session, "CREATE TABLE billing.invoices (id int)", &[])
        .await
        .unwrap();
    assert!(schema_names(&session).await.contains(&"billing".to_owned()));

    // Again: it exists.
    let err = run(
        &session,
        ObjectOperation::CreateSchema(CreateSchema {
            name: "billing".into(),
            owner: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(err.pg_code(), Some("42P06"), "{err:?}");

    // Rename: what is in it comes along.
    run(
        &session,
        ObjectOperation::RenameSchema(RenameSchema {
            name: "billing".into(),
            new_name: "finance".into(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(
        values(&session, "SELECT count(*)::text FROM finance.invoices").await[0][0],
        Some("0".into())
    );
    let names = schema_names(&session).await;
    assert!(names.contains(&"finance".to_owned()) && !names.contains(&"billing".to_owned()));

    // A schema with something in it needs CASCADE.
    let drop_schema = |cascade| {
        ObjectOperation::DropSchema(DropSchema {
            name: "finance".into(),
            cascade,
        })
    };
    let err = run(&session, drop_schema(false)).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("2BP01"), "{err:?}");
    assert!(schema_names(&session).await.contains(&"finance".to_owned()));
    run(&session, drop_schema(true)).await.unwrap();
    assert!(!schema_names(&session).await.contains(&"finance".to_owned()));

    drop(session);
    target.drop_it(&dev).await;
    let _ = (DEV_PASSWORD, dev_config);
}
