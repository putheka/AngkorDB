//! Applying staged edits to a real database (ANG-23).
//!
//! Every test works in its own scratch schema, copied from the seeded tables, and drops it
//! afterwards, so the seed data other tests read is never touched.

mod common;

use std::collections::BTreeMap;

use angkordb_lib::db::changes::{apply_changes, preview_changes};
use angkordb_lib::db::rows::fetch_rows;
use angkordb_lib::db::session::Session;
use angkordb_lib::models::changes::{CellValue, RowInsert, RowRef, RowUpdate, TableChanges};
use angkordb_lib::models::rows::{RowPage, RowQuery};
use common::open_or_skip;

async fn sql(session: &Session, statements: &str) {
    session
        .meta()
        .await
        .unwrap()
        .batch_execute(statements)
        .await
        .unwrap_or_else(|e| panic!("{statements}\n{e:?}"));
}

/// A fresh schema for one test.
async fn scratch(session: &Session, schema: &str, ddl: &str) {
    sql(
        session,
        &format!("DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema}; {ddl}"),
    )
    .await;
}

async fn cleanup(session: &Session, schema: &str) {
    sql(session, &format!("DROP SCHEMA IF EXISTS {schema} CASCADE")).await;
}

async fn page(session: &Session, schema: &str, table: &str) -> RowPage {
    let client = session.meta().await.unwrap();
    fetch_rows(
        &client,
        &RowQuery {
            schema: schema.into(),
            table: table.into(),
            limit: 1000,
            offset: 0,
            sort: vec![],
            filters: vec![],
            raw_where: None,
        },
    )
    .await
    .unwrap()
}

async fn apply(
    session: &Session,
    schema: &str,
    table: &str,
    changes: &TableChanges,
) -> Result<angkordb_lib::models::changes::ApplyResult, angkordb_lib::error::AppError> {
    let client = session.meta().await.unwrap();
    apply_changes(&client, schema, table, changes).await
}

fn text(value: &str) -> CellValue {
    CellValue::Value { text: value.into() }
}

fn key(column: &str, value: &str) -> RowRef {
    RowRef::Key {
        columns: vec![column.into()],
        values: vec![value.into()],
    }
}

fn values(pairs: &[(&str, CellValue)]) -> BTreeMap<String, CellValue> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

fn update(row: RowRef, pairs: &[(&str, CellValue)]) -> RowUpdate {
    RowUpdate {
        row,
        values: values(pairs),
    }
}

fn insert(pairs: &[(&str, CellValue)]) -> RowInsert {
    RowInsert {
        values: values(pairs),
    }
}

fn cell<'a>(page: &'a RowPage, row: usize, column: &str) -> Option<&'a str> {
    let at = page
        .columns
        .iter()
        .position(|c| c.name == column)
        .unwrap_or_else(|| panic!("no column {column}"));
    page.rows[row][at].as_deref()
}

/// The text of every cell of `page` as an edit that writes it back unchanged.
fn rewrite_everything(page: &RowPage, skip: &[&str]) -> Vec<RowUpdate> {
    (0..page.rows.len())
        .map(|r| RowUpdate {
            row: key("id", cell(page, r, "id").unwrap()),
            values: page
                .columns
                .iter()
                .enumerate()
                .filter(|(_, c)| !skip.contains(&c.name.as_str()))
                .map(|(i, c)| {
                    let value = match &page.rows[r][i] {
                        Some(t) => text(t),
                        None => CellValue::Null,
                    };
                    (c.name.clone(), value)
                })
                .collect(),
        })
        .collect()
}

#[tokio::test]
async fn every_seed_type_survives_a_write_back_unchanged() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_roundtrip";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.users (LIKE public.users INCLUDING ALL);
             INSERT INTO {schema}.users OVERRIDING SYSTEM VALUE
               SELECT * FROM public.users WHERE id <= 5;"
        ),
    )
    .await;

    // jsonb, json, arrays, enum, citext, numeric(20,6), bytea, inet, interval, ranges, a
    // bigint above 2^53, Khmer text, quotes, newlines, empty strings and NULLs: all of it,
    // read as text by the grid, written back as text by the engine.
    let before = page(&session, schema, "users").await;
    assert_eq!(before.rows.len(), 5);
    let updates = rewrite_everything(&before, &["id"]);
    let result = apply(
        &session,
        schema,
        "users",
        &TableChanges {
            updates,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!((result.updated, result.deleted), (5, 0));

    let after = page(&session, schema, "users").await;
    assert_eq!(before.rows, after.rows, "writing a value back changed it");
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn edited_values_read_back_exactly() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_exact";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.users (LIKE public.users INCLUDING ALL);
             INSERT INTO {schema}.users OVERRIDING SYSTEM VALUE
               SELECT * FROM public.users WHERE id <= 5;"
        ),
    )
    .await;

    let edits = [
        update(
            key("id", "1"),
            &[
                // Above 2^53: a JS number would round it.
                ("big_counter", text("9007199254740995")),
                ("balance", text("0.000001")),
                ("name", text("សុភា ចាន់ 🙏")),
                (
                    "tags",
                    text(r#"{"has,comma","has\"quote","with space",NULL}"#),
                ),
                ("scores", text("{}")),
                (
                    "profile",
                    text(r#"{"a": [1, 2, {"b": null}], "ключ": "значение"}"#),
                ),
                ("status", text("suspended")),
                ("is_admin", text("false")),
                ("avatar", text("\\x00ff00")),
                ("last_ip", text("2001:db8::1/64")),
                ("session_length", text("1 day 02:03:04")),
                ("wake_time", text("23:59:59")),
                (
                    "active_period",
                    text("[2027-01-01 00:00:00+00,2027-02-01 00:00:00+00)"),
                ),
                (
                    "bio",
                    text("Line one\nLine two\ttabbed 'quoted' \"double\" \\ backslash"),
                ),
                ("country", text("TH")),
            ],
        ),
        update(
            key("id", "2"),
            &[
                // An empty string is a value, not NULL.
                ("bio", text("")),
                ("name", CellValue::Null),
                // DEFAULT is the column's own default (`false`).
                ("is_admin", CellValue::Default),
            ],
        ),
    ];
    apply(
        &session,
        schema,
        "users",
        &TableChanges {
            updates: edits.into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let after = page(&session, schema, "users").await;
    let (a, b) = (0, 1);
    assert_eq!(cell(&after, a, "big_counter"), Some("9007199254740995"));
    assert_eq!(cell(&after, a, "balance"), Some("0.000001"));
    assert_eq!(cell(&after, a, "name"), Some("សុភា ចាន់ 🙏"));
    assert_eq!(
        cell(&after, a, "tags"),
        Some(r#"{"has,comma","has\"quote","with space",NULL}"#)
    );
    assert_eq!(cell(&after, a, "scores"), Some("{}"));
    assert_eq!(
        cell(&after, a, "profile"),
        Some(r#"{"a": [1, 2, {"b": null}], "ключ": "значение"}"#)
    );
    assert_eq!(cell(&after, a, "status"), Some("suspended"));
    assert_eq!(cell(&after, a, "is_admin"), Some("false"));
    assert_eq!(cell(&after, a, "avatar"), Some("\\x00ff00"));
    assert_eq!(cell(&after, a, "last_ip"), Some("2001:db8::1/64"));
    assert_eq!(cell(&after, a, "session_length"), Some("1 day 02:03:04"));
    assert_eq!(cell(&after, a, "wake_time"), Some("23:59:59"));
    assert_eq!(
        cell(&after, a, "active_period"),
        Some(r#"["2027-01-01 00:00:00+00","2027-02-01 00:00:00+00")"#)
    );
    assert_eq!(
        cell(&after, a, "bio"),
        Some("Line one\nLine two\ttabbed 'quoted' \"double\" \\ backslash")
    );
    assert_eq!(cell(&after, a, "country"), Some("TH"));

    assert_eq!(cell(&after, b, "bio"), Some(""));
    assert_eq!(cell(&after, b, "name"), None);
    assert_eq!(cell(&after, b, "is_admin"), Some("false"));
    // The row we did not touch is as it was.
    assert_eq!(
        cell(&after, 2, "email"),
        Some("quote@example.com"),
        "untouched rows keep their data"
    );
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn update_insert_and_delete_commit_together() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_mixed";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.items (
               id serial PRIMARY KEY,
               name text NOT NULL,
               qty integer NOT NULL DEFAULT 1,
               added timestamptz NOT NULL DEFAULT now()
             );
             INSERT INTO {schema}.items (name) VALUES ('a'), ('b'), ('c');"
        ),
    )
    .await;

    let result = apply(
        &session,
        schema,
        "items",
        &TableChanges {
            updates: vec![update(
                key("id", "2"),
                &[("name", text("B!")), ("qty", text("5"))],
            )],
            // `qty` and `added` are not listed: they take their defaults.
            inserts: vec![
                insert(&[("name", text("d"))]),
                insert(&[("name", text("e")), ("qty", CellValue::Default)]),
            ],
            deletes: vec![key("id", "3")],
        },
    )
    .await
    .unwrap();
    assert_eq!((result.updated, result.deleted), (1, 1));

    // RETURNING: the serial and the defaults come back, in table column order.
    assert_eq!(result.inserted.len(), 2);
    assert_eq!(result.inserted[0][0].as_deref(), Some("4"));
    assert_eq!(result.inserted[0][1].as_deref(), Some("d"));
    assert_eq!(result.inserted[0][2].as_deref(), Some("1"));
    assert!(result.inserted[0][3].is_some(), "now() was filled in");
    assert_eq!(result.inserted[1][0].as_deref(), Some("5"));

    let after = page(&session, schema, "items").await;
    let names: Vec<_> = (0..after.rows.len())
        .map(|r| cell(&after, r, "name").unwrap())
        .collect();
    assert_eq!(names, ["a", "B!", "d", "e"]);
    assert_eq!(cell(&after, 1, "qty"), Some("5"));
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn a_deleted_key_can_be_reused_in_the_same_batch() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_reuse";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.t (code text PRIMARY KEY, label text);
             INSERT INTO {schema}.t VALUES ('A', 'old');"
        ),
    )
    .await;
    apply(
        &session,
        schema,
        "t",
        &TableChanges {
            inserts: vec![insert(&[("code", text("A")), ("label", text("new"))])],
            deletes: vec![key("code", "A")],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let after = page(&session, schema, "t").await;
    assert_eq!(after.rows.len(), 1);
    assert_eq!(cell(&after, 0, "label"), Some("new"));
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn a_failing_change_rolls_everything_back_and_names_itself() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_rollback";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.codes (code varchar(3) PRIMARY KEY, label text);
             INSERT INTO {schema}.codes VALUES ('KH', 'Cambodia'), ('TH', 'Thailand');"
        ),
    )
    .await;

    let err = apply(
        &session,
        schema,
        "codes",
        &TableChanges {
            deletes: vec![key("code", "TH")],
            updates: vec![update(key("code", "KH"), &[("label", text("changed"))])],
            // Too long for varchar(3): the server must refuse it, not truncate it.
            inserts: vec![insert(&[("code", text("TOOLONG"))])],
        },
    )
    .await
    .unwrap_err();

    assert_eq!(err.code(), "CHANGE_FAILED");
    assert_eq!(err.pg_code(), Some("22001"));
    let message = err.message();
    assert!(
        message.contains("Change 3 of 3 (insert new row 1)")
            && message.contains("value too long for type character varying(3)")
            && message.ends_with("nothing was saved."),
        "{message}"
    );

    // The delete and the update that came before the failure were rolled back.
    let after = page(&session, schema, "codes").await;
    assert_eq!(after.rows.len(), 2);
    assert_eq!(cell(&after, 0, "label"), Some("Cambodia"));
    assert_eq!(cell(&after, 1, "code"), Some("TH"));

    // The connection did not keep the failed transaction.
    let client = session.meta().await.unwrap();
    let idle: bool = client
        .query_one("SELECT pg_current_xact_id_if_assigned() IS NULL", &[])
        .await
        .unwrap()
        .get(0);
    assert!(idle);
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn a_constraint_violation_names_the_change_and_keeps_the_postgres_details() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_constraint";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.t (id int PRIMARY KEY, name text NOT NULL UNIQUE);
             INSERT INTO {schema}.t VALUES (1, 'a'), (2, 'b');"
        ),
    )
    .await;

    let unique = apply(
        &session,
        schema,
        "t",
        &TableChanges {
            updates: vec![update(key("id", "2"), &[("name", text("a"))])],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(unique.pg_code(), Some("23505"));
    assert!(
        unique.message().contains("update row id = 2"),
        "{}",
        unique.message()
    );

    let not_null = apply(
        &session,
        schema,
        "t",
        &TableChanges {
            updates: vec![update(key("id", "1"), &[("name", CellValue::Null)])],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(not_null.pg_code(), Some("23502"));

    // A value that isn't valid for the type.
    let bad_type = apply(
        &session,
        schema,
        "t",
        &TableChanges {
            updates: vec![update(key("id", "abc"), &[("name", text("x"))])],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(bad_type.pg_code(), Some("22P02"));
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn a_row_changed_or_deleted_meanwhile_rolls_back() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_conflict";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.t (id int PRIMARY KEY, name text);
             INSERT INTO {schema}.t VALUES (1, 'a'), (2, 'b');"
        ),
    )
    .await;
    // Someone else deletes row 2 after we loaded the page.
    sql(&session, &format!("DELETE FROM {schema}.t WHERE id = 2")).await;

    let err = apply(
        &session,
        schema,
        "t",
        &TableChanges {
            updates: vec![
                update(key("id", "1"), &[("name", text("mine"))]),
                update(key("id", "2"), &[("name", text("mine too"))]),
            ],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code(), "CHANGE_FAILED");
    assert!(
        err.message()
            .contains("Change 2 of 2 (update row id = 2) failed: row changed or missing"),
        "{}",
        err.message()
    );
    let after = page(&session, schema, "t").await;
    assert_eq!(
        cell(&after, 0, "name"),
        Some("a"),
        "the first update was rolled back"
    );

    // Deleting a row that is already gone is the same conflict.
    let err = apply(
        &session,
        schema,
        "t",
        &TableChanges {
            deletes: vec![key("id", "2")],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert!(
        err.message().contains("row changed or missing"),
        "{}",
        err.message()
    );
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn tables_without_a_key_are_edited_by_ctid_one_row_at_a_time() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_ctid";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.log (level text, message text);
             INSERT INTO {schema}.log VALUES ('info', 'same'), ('info', 'same'), ('warn', 'x');"
        ),
    )
    .await;

    let before = page(&session, schema, "log").await;
    assert_eq!(before.ctids.len(), 3);
    // Two rows are exact duplicates; only the one we point at changes.
    apply(
        &session,
        schema,
        "log",
        &TableChanges {
            updates: vec![update(
                RowRef::Ctid {
                    ctid: before.ctids[1].clone(),
                },
                &[("message", text("edited"))],
            )],
            deletes: vec![RowRef::Ctid {
                ctid: before.ctids[2].clone(),
            }],
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let after = page(&session, schema, "log").await;
    let mut messages: Vec<_> = (0..after.rows.len())
        .map(|r| cell(&after, r, "message").unwrap().to_owned())
        .collect();
    messages.sort();
    assert_eq!(messages, ["edited", "same"]);
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn composite_and_unique_index_keys_work_in_any_column_order() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_keys";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.order_items (LIKE public.order_items INCLUDING ALL);
             INSERT INTO {schema}.order_items SELECT * FROM public.order_items WHERE order_id <= 2;
             CREATE TABLE {schema}.app_settings (LIKE public.app_settings INCLUDING ALL);
             INSERT INTO {schema}.app_settings SELECT * FROM public.app_settings;"
        ),
    )
    .await;

    // The key's columns listed in the opposite order of the index.
    apply(
        &session,
        schema,
        "order_items",
        &TableChanges {
            updates: vec![update(
                RowRef::Key {
                    columns: vec!["line_no".into(), "order_id".into()],
                    values: vec!["2".into(), "1".into()],
                },
                &[("qty", text("42"))],
            )],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let items = page(&session, schema, "order_items").await;
    let changed: Vec<_> = (0..items.rows.len())
        .filter(|&r| cell(&items, r, "qty") == Some("42"))
        .collect();
    assert_eq!(changed.len(), 1);
    assert_eq!(cell(&items, changed[0], "order_id"), Some("1"));
    assert_eq!(cell(&items, changed[0], "line_no"), Some("2"));

    // A key column can itself be edited, and NOT NULL unique indexes identify rows.
    apply(
        &session,
        schema,
        "app_settings",
        &TableChanges {
            updates: vec![update(
                key("key", "theme"),
                &[("key", text("colour")), ("value", CellValue::Null)],
            )],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let settings = page(&session, schema, "app_settings").await;
    let keys: Vec<_> = (0..settings.rows.len())
        .map(|r| cell(&settings, r, "key").unwrap())
        .collect();
    assert!(
        keys.contains(&"colour") && !keys.contains(&"theme"),
        "{keys:?}"
    );
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn read_only_tables_and_bad_input_write_nothing() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_refuse";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.t (id int PRIMARY KEY, name text);
             INSERT INTO {schema}.t VALUES (1, 'a');
             CREATE VIEW {schema}.v AS SELECT * FROM {schema}.t;"
        ),
    )
    .await;

    let err = apply(
        &session,
        schema,
        "v",
        &TableChanges {
            inserts: vec![insert(&[("name", text("x"))])],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code(), "VALIDATION");

    for bad in [
        update(key("id", "1"), &[("name\" = 'x'; --", text("x"))]),
        update(key("name", "a"), &[("name", text("x"))]), // not the key
    ] {
        let err = apply(
            &session,
            schema,
            "t",
            &TableChanges {
                updates: vec![bad],
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "VALIDATION", "{err:?}");
    }
    let err = apply(
        &session,
        schema,
        "missing",
        &TableChanges {
            deletes: vec![key("id", "1")],
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code(), "NOT_FOUND");

    assert_eq!(page(&session, schema, "t").await.rows.len(), 1);
    cleanup(&session, schema).await;
}

#[tokio::test]
async fn nothing_staged_does_nothing() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = apply(&session, "public", "users", &TableChanges::default())
        .await
        .unwrap();
    assert_eq!(
        (result.updated, result.deleted, result.inserted.len()),
        (0, 0, 0)
    );
}

#[tokio::test]
async fn the_preview_shows_the_sql_and_changes_nothing() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_preview";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.t (id int PRIMARY KEY, name text);
             INSERT INTO {schema}.t VALUES (1, 'a');"
        ),
    )
    .await;

    let changes = TableChanges {
        updates: vec![update(key("id", "1"), &[("name", text("it's"))])],
        inserts: vec![insert(&[("id", text("2")), ("name", CellValue::Null)])],
        deletes: vec![],
    };
    let client = session.meta().await.unwrap();
    let shown = preview_changes(&client, schema, "t", &changes)
        .await
        .unwrap();
    drop(client);
    assert_eq!(
        shown,
        format!(
            "BEGIN;\n\
             UPDATE \"{schema}\".\"t\" SET \"name\" = 'it''s' WHERE \"id\" = '1';\n\
             INSERT INTO \"{schema}\".\"t\" (\"id\", \"name\") VALUES ('2', NULL);\n\
             COMMIT;"
        )
    );
    let after = page(&session, schema, "t").await;
    assert_eq!(after.rows.len(), 1);
    assert_eq!(cell(&after, 0, "name"), Some("a"));
    cleanup(&session, schema).await;
}

/// `char(n)` and `bit(n)` used to be cast as `character` / `bit`, which cut a value to one
/// character: writing "KH" stored "K", and filtering by "KH" looked for "K".
#[tokio::test]
async fn fixed_width_types_are_never_cut_short_by_a_cast() {
    use angkordb_lib::models::rows::{Filter, FilterOp};

    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang23_fixed";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.t (id int PRIMARY KEY, c char(2), b bit(3));
             INSERT INTO {schema}.t VALUES (1, 'AA', B'000');"
        ),
    )
    .await;

    apply(
        &session,
        schema,
        "t",
        &TableChanges {
            updates: vec![update(
                key("id", "1"),
                &[("c", text("KH")), ("b", text("101"))],
            )],
            inserts: vec![insert(&[
                ("id", text("2")),
                ("c", text("K")),
                ("b", text("010")),
            ])],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let after = page(&session, schema, "t").await;
    assert_eq!(cell(&after, 0, "c"), Some("KH"));
    assert_eq!(cell(&after, 0, "b"), Some("101"));
    // Stored padded as "K ", but `::text` (how rows are read) drops the padding.
    assert_eq!(cell(&after, 1, "c"), Some("K"));

    // Too long is an error from the column, never a silent cut.
    for (column, value, code) in [("c", "KHX", "22001"), ("b", "1010", "22026")] {
        let err = apply(
            &session,
            schema,
            "t",
            &TableChanges {
                updates: vec![update(key("id", "1"), &[(column, text(value))])],
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.pg_code(), Some(code), "{column}: {}", err.message());
    }

    // Filtering uses the same cast.
    let client = session.meta().await.unwrap();
    let found = fetch_rows(
        &client,
        &RowQuery {
            schema: schema.into(),
            table: "t".into(),
            limit: 10,
            offset: 0,
            sort: vec![],
            filters: vec![Filter {
                column: "c".into(),
                op: FilterOp::Eq,
                values: vec!["KH".into()],
            }],
            raw_where: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(found.rows.len(), 1);
    drop(client);
    cleanup(&session, schema).await;
}

/// Pasting the rows of a table back into itself (ANG-28): every pasted row is an insert with the
/// same values, so the keys clash. The server's refusal names the pasted row, and nothing is saved.
#[tokio::test]
async fn pasting_existing_rows_back_reports_the_key_conflict() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang28_paste";
    scratch(
        &session,
        schema,
        &format!(
            "CREATE TABLE {schema}.codes (code varchar(3) PRIMARY KEY, label text);
             INSERT INTO {schema}.codes VALUES ('KH', 'Cambodia'), ('TH', 'Thailand'), ('VN', 'Vietnam');"
        ),
    )
    .await;

    let copied = page(&session, schema, "codes").await;
    let pasted: Vec<RowInsert> = copied
        .rows
        .iter()
        .map(|row| {
            insert(&[
                ("code", text(row[0].as_deref().unwrap())),
                ("label", text(row[1].as_deref().unwrap())),
            ])
        })
        .collect();
    assert_eq!(pasted.len(), 3);

    let err = apply(
        &session,
        schema,
        "codes",
        &TableChanges {
            inserts: pasted,
            ..Default::default()
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.code(), "CHANGE_FAILED");
    assert_eq!(err.pg_code(), Some("23505"));
    let message = err.message();
    assert!(
        message.contains("Change 1 of 3 (insert new row 1)")
            && message.contains("duplicate key value violates unique constraint")
            && message.ends_with("nothing was saved."),
        "{message}"
    );
    assert_eq!(page(&session, schema, "codes").await.rows.len(), 3);

    // The same rows with new keys go in, all three in one transaction.
    let result = apply(
        &session,
        schema,
        "codes",
        &TableChanges {
            inserts: vec![
                insert(&[("code", text("LA")), ("label", text("Laos"))]),
                insert(&[("code", text("MM")), ("label", CellValue::Null)]),
            ],
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(result.inserted.len(), 2);
    assert_eq!(page(&session, schema, "codes").await.rows.len(), 5);
    cleanup(&session, schema).await;
}
