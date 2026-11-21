//! Definitions of functions, views, sequences and enums, and the operations on them, run for
//! real in scratch databases (see `common`).

mod common;

use angkordb_lib::db::definitions::{definition, sequence_info};
use angkordb_lib::db::introspect;
use angkordb_lib::db::objects::apply;
use angkordb_lib::db::query::run_script;
use angkordb_lib::db::session::Session;
use angkordb_lib::db::structure::table_structure;
use angkordb_lib::error::AppError;
use angkordb_lib::models::objects::{
    AddEnumValue, EnumPosition, ObjectOperation, RefreshMaterializedView, SetSequence,
};
use angkordb_lib::models::query::StatementOutcome;
use angkordb_lib::models::schema::ObjectKind;
use common::{Scratch, open_or_skip, run_all};

const SETUP: &str = r#"
CREATE TABLE items (id serial PRIMARY KEY, name text, price numeric);
INSERT INTO items (name, price) VALUES ('a', 1), ('b', 2), ('c', 3);
CREATE FUNCTION greet(p_name text DEFAULT 'world') RETURNS text LANGUAGE sql AS $$ SELECT 'Hello, ' || p_name $$;
CREATE FUNCTION area(w integer, h integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT w * h $$;
CREATE FUNCTION area(r numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT 3.14159 * r * r $$;
CREATE PROCEDURE bump(p integer) LANGUAGE plpgsql AS $$ BEGIN UPDATE items SET price = price + p; END $$;
CREATE AGGREGATE total(numeric) (SFUNC = numeric_add, STYPE = numeric, INITCOND = '0');
CREATE VIEW cheap AS SELECT id, name FROM items WHERE price < 3;
CREATE MATERIALIZED VIEW totals AS SELECT count(*) AS n, sum(price) AS total FROM items;
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');
"#;

async fn scratch(label: &str) -> Option<(Session, Scratch, Session)> {
    let dev = open_or_skip().await?;
    let db = Scratch::create(&dev, label).await;
    let session = db.open().await;
    run_all(&session, SETUP, &[]).await.unwrap();
    Some((session, db, dev))
}

async fn oid(session: &Session, sql: &str) -> u32 {
    session
        .meta()
        .await
        .unwrap()
        .query_one(sql, &[])
        .await
        .unwrap()
        .get(0)
}

async fn def(session: &Session, kind: ObjectKind, name: &str, oid: u32) -> String {
    let client = session.meta().await.unwrap();
    definition(&client, kind, "public", name, oid)
        .await
        .unwrap()
        .sql
}

async fn values(session: &Session, sql: &str) -> Vec<Vec<Option<String>>> {
    let run = run_script(session, "t", sql).await.unwrap();
    match &run.statements[0].outcome {
        StatementOutcome::Rows { rows, .. } => rows.clone(),
        other => panic!("{sql}: {other:?}"),
    }
}

async fn run(session: &Session, op: ObjectOperation) -> angkordb_lib::error::AppResult<u32> {
    let client = session.meta().await.unwrap();
    apply(&client, &op, 5_000).await
}

#[tokio::test]
async fn editing_a_function_and_running_it_changes_the_definition() {
    let Some((session, db, dev)) = scratch("function").await else {
        return;
    };
    let greet = oid(&session, "SELECT 'public.greet'::regproc::oid").await;
    let source = def(&session, ObjectKind::Function, "greet", greet).await;
    assert!(
        source.starts_with(
            "CREATE OR REPLACE FUNCTION public.greet(p_name text DEFAULT 'world'::text)"
        ),
        "{source}"
    );
    assert!(source.contains("RETURNS text"), "{source}");
    assert!(
        source.trim_end().ends_with("$function$;") || source.trim_end().ends_with("$$;"),
        "{source}"
    );

    // Edit the text and run it, as the query tab would: the function in the database changes.
    let edited = source.replace("'Hello, '", "'Goodbye, '");
    assert_ne!(edited, source);
    run_all(&session, &edited, &[]).await.unwrap();
    assert_eq!(
        values(&session, "SELECT greet('Bob')").await[0][0],
        Some("Goodbye, Bob".into())
    );
    let again = def(&session, ObjectKind::Function, "greet", greet).await;
    assert!(again.contains("Goodbye, "), "{again}");

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn overloads_procedures_and_aggregates() {
    let Some((session, db, dev)) = scratch("overloads").await else {
        return;
    };
    let two = oid(
        &session,
        "SELECT 'public.area(integer, integer)'::regprocedure::oid",
    )
    .await;
    let one = oid(&session, "SELECT 'public.area(numeric)'::regprocedure::oid").await;
    assert_ne!(one, two);
    assert!(
        def(&session, ObjectKind::Function, "area", two)
            .await
            .contains("w * h")
    );
    assert!(
        def(&session, ObjectKind::Function, "area", one)
            .await
            .contains("3.14159")
    );

    let bump = oid(&session, "SELECT 'public.bump(integer)'::regprocedure::oid").await;
    let source = def(&session, ObjectKind::Procedure, "bump", bump).await;
    assert!(
        source.contains("CREATE OR REPLACE PROCEDURE public.bump"),
        "{source}"
    );

    let total = oid(
        &session,
        "SELECT 'public.total(numeric)'::regprocedure::oid",
    )
    .await;
    let client = session.meta().await.unwrap();
    let err = definition(&client, ObjectKind::Function, "public", "total", total)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    assert!(err.message().contains("aggregate"), "{}", err.message());
    // The client is not left in an aborted transaction.
    drop(client);
    assert_eq!(
        values(&session, "SELECT 1::text").await[0][0],
        Some("1".into())
    );

    // The wrong schema or name for that oid is not found.
    let client = session.meta().await.unwrap();
    assert!(matches!(
        definition(&client, ObjectKind::Function, "public", "nope", two).await,
        Err(AppError::NotFound(_))
    ));

    drop(client);
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_view_definition_is_replaced_in_place() {
    let Some((session, db, dev)) = scratch("view").await else {
        return;
    };
    let source = def(&session, ObjectKind::View, "cheap", 0).await;
    assert!(
        source.starts_with("CREATE OR REPLACE VIEW public.cheap AS\nSELECT"),
        "{source}"
    );
    // Every table in it is named in full.
    assert!(source.contains("FROM public.items"), "{source}");

    // Add a column at the end, run it, and the view has it.
    let edited = source
        .replace("name\n", "name,\n    price\n")
        .replace("name FROM", "name, price FROM");
    let edited = if edited == source {
        source.replacen("name", "name, price", 1)
    } else {
        edited
    };
    run_all(&session, &edited, &[]).await.unwrap();
    let columns = table_structure(&session.meta().await.unwrap(), "public", "cheap")
        .await
        .unwrap()
        .columns
        .iter()
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    assert_eq!(columns, ["id", "name", "price"]);

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_materialized_view_is_recreated_with_its_indexes_and_can_be_refreshed() {
    let Some((session, db, dev)) = scratch("matview").await else {
        return;
    };
    run_all(&session, "CREATE UNIQUE INDEX totals_n ON totals (n)", &[])
        .await
        .unwrap();
    let source = def(&session, ObjectKind::MaterializedView, "totals", 0).await;
    assert!(
        source.contains("DROP MATERIALIZED VIEW public.totals;"),
        "{source}"
    );
    assert!(
        source.contains("CREATE MATERIALIZED VIEW public.totals AS"),
        "{source}"
    );
    assert!(source.contains("WITH DATA;"), "{source}");
    assert!(
        source.contains("CREATE UNIQUE INDEX totals_n ON public.totals"),
        "{source}"
    );
    // It runs as it is: the view is made again, indexes included.
    run_all(&session, &source, &[]).await.unwrap();
    let after = table_structure(&session.meta().await.unwrap(), "public", "totals")
        .await
        .unwrap();
    assert!(after.indexes.iter().any(|i| i.name == "totals_n"));

    // Refresh: it picks up new rows, plain and CONCURRENTLY (it has a unique index now).
    run_all(
        &session,
        "INSERT INTO items (name, price) VALUES ('d', 4)",
        &[],
    )
    .await
    .unwrap();
    let refresh = |concurrently, with_no_data| {
        ObjectOperation::RefreshMaterializedView(RefreshMaterializedView {
            schema: "public".into(),
            name: "totals".into(),
            concurrently,
            with_no_data,
        })
    };
    run(&session, refresh(false, false)).await.unwrap();
    assert_eq!(
        values(&session, "SELECT n::text FROM totals").await[0][0],
        Some("4".into())
    );
    run_all(
        &session,
        "INSERT INTO items (name, price) VALUES ('e', 5)",
        &[],
    )
    .await
    .unwrap();
    run(&session, refresh(true, false)).await.unwrap();
    assert_eq!(
        values(&session, "SELECT n::text FROM totals").await[0][0],
        Some("5".into())
    );

    // WITH NO DATA empties it.
    run(&session, refresh(false, true)).await.unwrap();
    let emptied = table_structure(&session.meta().await.unwrap(), "public", "totals")
        .await
        .unwrap();
    assert_eq!(emptied.info.populated, Some(false));

    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn concurrent_refresh_needs_a_unique_index() {
    let Some((session, db, dev)) = scratch("norefresh").await else {
        return;
    };
    let err = run(
        &session,
        ObjectOperation::RefreshMaterializedView(RefreshMaterializedView {
            schema: "public".into(),
            name: "totals".into(),
            concurrently: true,
            with_no_data: false,
        }),
    )
    .await
    .unwrap_err();
    assert!(matches!(err, AppError::Postgres(_)), "{err:?}");
    assert!(
        err.message().contains("cannot refresh"),
        "{}",
        err.message()
    );
    // The server says what to do about it.
    let AppError::Postgres(e) = &err else {
        panic!()
    };
    let hint = e.as_db_error().and_then(|d| d.hint()).unwrap_or("");
    assert!(hint.contains("unique index"), "{hint}");
    // The connection is fine afterwards.
    assert_eq!(
        values(&session, "SELECT 1::text").await[0][0],
        Some("1".into())
    );
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn a_sequence_shows_its_settings_and_can_be_set() {
    let Some((session, db, dev)) = scratch("sequence").await else {
        return;
    };
    let client = session.meta().await.unwrap();
    let before = sequence_info(&client, "public", "items_id_seq")
        .await
        .unwrap();
    drop(client);
    assert_eq!(before.data_type, "integer");
    assert_eq!(before.increment, "1");
    assert_eq!(before.max, "2147483647");
    assert_eq!(before.owned_by.as_deref(), Some("public.items.id"));
    // Three rows were inserted with the serial.
    assert_eq!(before.last_value.as_deref(), Some("3"));

    let set = |value: &str, is_called| {
        ObjectOperation::SetSequence(SetSequence {
            schema: "public".into(),
            name: "items_id_seq".into(),
            value: value.into(),
            is_called,
        })
    };
    // Called: the next is the one after.
    run(&session, set("100", true)).await.unwrap();
    run_all(&session, "INSERT INTO items (name) VALUES ('x')", &[])
        .await
        .unwrap();
    assert_eq!(
        values(&session, "SELECT max(id)::text FROM items").await[0][0],
        Some("101".into())
    );
    // Not called: the next is the value itself.
    run(&session, set("500", false)).await.unwrap();
    run_all(&session, "INSERT INTO items (name) VALUES ('y')", &[])
        .await
        .unwrap();
    assert_eq!(
        values(&session, "SELECT max(id)::text FROM items").await[0][0],
        Some("500".into())
    );

    // A value outside its range is the server's error, and nothing changed.
    let err = run(&session, set("99999999999", true)).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("22003"), "{err:?}");

    // The text version of the sequence names its settings.
    let source = def(&session, ObjectKind::Sequence, "items_id_seq", 0).await;
    assert!(
        source.starts_with("CREATE SEQUENCE public.items_id_seq AS integer START WITH 1"),
        "{source}"
    );
    assert!(source.contains("-- Owned by public.items.id."), "{source}");

    // Never used: no current value.
    run_all(&session, "CREATE SEQUENCE fresh START 10", &[])
        .await
        .unwrap();
    let client = session.meta().await.unwrap();
    let fresh = sequence_info(&client, "public", "fresh").await.unwrap();
    assert_eq!(fresh.last_value, None);
    assert_eq!(fresh.start, "10");
    assert_eq!(fresh.owned_by, None);
    assert!(matches!(
        sequence_info(&client, "public", "nope").await,
        Err(AppError::NotFound(_))
    ));

    drop(client);
    drop(session);
    db.drop_it(&dev).await;
}

#[tokio::test]
async fn enum_values_can_be_added_at_the_end_before_and_after() {
    let Some((session, db, dev)) = scratch("enum").await else {
        return;
    };
    let mood = oid(&session, "SELECT 'public.mood'::regtype::oid").await;
    let source = def(&session, ObjectKind::EnumType, "mood", mood).await;
    assert!(
        source.starts_with("CREATE TYPE public.mood AS ENUM ('sad', 'ok', 'happy');"),
        "{source}"
    );

    let add = |value: &str, position: Option<EnumPosition>, if_not_exists| {
        ObjectOperation::AddEnumValue(AddEnumValue {
            schema: "public".into(),
            name: "mood".into(),
            value: value.into(),
            position,
            if_not_exists,
        })
    };
    run(&session, add("ecstatic", None, false)).await.unwrap();
    run(
        &session,
        add(
            "meh",
            Some(EnumPosition {
                before: true,
                existing: "ok".into(),
            }),
            false,
        ),
    )
    .await
    .unwrap();
    run(
        &session,
        add(
            "fine",
            Some(EnumPosition {
                before: false,
                existing: "ok".into(),
            }),
            false,
        ),
    )
    .await
    .unwrap();
    let client = session.meta().await.unwrap();
    assert_eq!(
        introspect::enum_values(&client, mood).await.unwrap(),
        ["sad", "meh", "ok", "fine", "happy", "ecstatic"]
    );
    drop(client);

    // A value that is there: refused, or skipped with IF NOT EXISTS.
    let err = run(&session, add("ok", None, false)).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("42710"), "{err:?}");
    run(&session, add("ok", None, true)).await.unwrap();
    // A value with a quote in it.
    run(&session, add("it's", None, false)).await.unwrap();
    let client = session.meta().await.unwrap();
    assert!(
        introspect::enum_values(&client, mood)
            .await
            .unwrap()
            .contains(&"it's".to_owned())
    );

    drop(client);
    drop(session);
    db.drop_it(&dev).await;
}
