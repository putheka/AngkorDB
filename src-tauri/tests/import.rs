//! Importing files into tables, for real (see `common`): CSV and JSON, column mapping, a new
//! table from the file, errors with their line numbers, cancelling and a million rows.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use angkordb_lib::db::export::{self, ExportJob};
use angkordb_lib::db::import::{self, ImportJob, preview};
use angkordb_lib::db::session::Session;
use angkordb_lib::error::AppError;
use angkordb_lib::models::export::{
    CsvOptions, ExportFormat, ExportRequest, ExportSource, TableExport,
};
use angkordb_lib::models::import::{
    ColumnMap, ImportFormat, ImportRequest, ImportState, ImportStatus, ImportTarget, NewColumn,
    OnError, PreviewRequest,
};
use common::{Scratch, open_or_skip, run_all};
use tempfile::TempDir;

fn csv(delimiter: &str, header: bool, null_text: &str) -> ImportFormat {
    ImportFormat::Csv {
        delimiter: delimiter.into(),
        quote: "\"".into(),
        header,
        null_text: null_text.into(),
    }
}

fn map(pairs: &[(&str, &str)]) -> Vec<ColumnMap> {
    pairs
        .iter()
        .map(|(s, c)| ColumnMap {
            source: (*s).into(),
            column: (*c).into(),
        })
        .collect()
}

fn existing(table: &str, pairs: &[(&str, &str)], truncate: bool) -> ImportTarget {
    ImportTarget::Existing {
        schema: "public".into(),
        table: table.into(),
        mapping: map(pairs),
        truncate,
    }
}

fn request(
    path: &Path,
    format: ImportFormat,
    target: ImportTarget,
    on_error: OnError,
) -> ImportRequest {
    ImportRequest {
        path: path.display().to_string(),
        format,
        target,
        on_error,
    }
}

async fn import(
    session: &Session,
    request: &ImportRequest,
) -> (Result<(), AppError>, ImportStatus) {
    let job = ImportJob::new();
    let result = import::run(session, &job, &uuid::Uuid::new_v4().to_string(), request).await;
    let outcome = match &result {
        Ok(()) => Ok(()),
        Err(e) => Err(AppError::Validation(e.message())),
    };
    job.finish(result);
    (outcome, job.snapshot())
}

async fn count(db: &Session, table: &str) -> i64 {
    db.meta()
        .await
        .unwrap()
        .query_one(&format!("SELECT count(*) FROM {table}"), &[])
        .await
        .unwrap()
        .get(0)
}

async fn diff(db: &Session, a: &str, b: &str) -> i64 {
    db.meta()
        .await
        .unwrap()
        .query_one(
            &format!(
                "SELECT (SELECT count(*) FROM ((SELECT x::text FROM {a} x) EXCEPT (SELECT y::text FROM {b} y)) d1)
                      + (SELECT count(*) FROM ((SELECT y::text FROM {b} y) EXCEPT (SELECT x::text FROM {a} x)) d2)"
            ),
            &[],
        )
        .await
        .unwrap()
        .get(0)
}

const MIXED: &str = "
CREATE TABLE mixed (
  id bigint PRIMARY KEY, name text, qty integer, price numeric(10,2), ratio double precision,
  active boolean, born timestamptz, meta jsonb, tags text[], raw bytea, note text
);
INSERT INTO mixed VALUES
 (1, 'plain', 3, 12.50, 0.5, true, '2026-01-02 03:04:05+00', '{\"a\": [1, 2], \"b\": null}', '{x,y}', '\\xdeadbeef', 'first'),
 (2, 'O''Brien, \"Bob\"', -7, 0, 1e20, false, NULL, '[]', '{}', '\\x', E'two\\nlines'),
 (3, E'back\\\\slash | pipe', NULL, 99999999.99, 'NaN', NULL, 'infinity', NULL, NULL, NULL, ''),
 (4, 'ünïcödé 日本', 0, -0.01, '-Infinity', true, '1999-12-31 23:59:59.123456+00', '{\"k\": \"v\"}', '{\"a b\",\"c,d\"}', '\\x00', NULL);
";

const COLUMNS: [&str; 11] = [
    "id", "name", "qty", "price", "ratio", "active", "born", "meta", "tags", "raw", "note",
];

fn all_columns() -> Vec<(&'static str, &'static str)> {
    COLUMNS.iter().map(|c| (*c, *c)).collect()
}

async fn scratch(admin: &Session, label: &str) -> (Scratch, Session) {
    let scratch = Scratch::create(admin, label).await;
    let db = scratch.open().await;
    (scratch, db)
}

async fn export_to(db: &Session, table: &str, format: ExportFormat, path: &Path) {
    let job = ExportJob::new();
    let request = ExportRequest {
        source: ExportSource::Table(TableExport {
            schema: "public".into(),
            table: table.into(),
            filters: vec![],
            raw_where: None,
            sort: vec![],
        }),
        format,
        path: path.display().to_string(),
    };
    export::run(db, &job, "import-test", &request)
        .await
        .unwrap();
}

#[tokio::test]
async fn what_the_export_writes_comes_back_in_csv_and_in_json() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = scratch(&dev, "import_round").await;
    run_all(&db, MIXED, &[]).await.unwrap();
    let dir = TempDir::new().unwrap();

    // CSV, with NULL written as \N so an empty text stays empty.
    let file = dir.path().join("mixed.csv");
    let format = ExportFormat::Csv(CsvOptions {
        delimiter: ",".into(),
        quote: "\"".into(),
        header: true,
        null_text: "\\N".into(),
    });
    export_to(&db, "mixed", format, &file).await;
    run_all(&db, "CREATE TABLE from_csv (LIKE mixed INCLUDING ALL)", &[])
        .await
        .unwrap();
    let (result, status) = import(
        &db,
        &request(
            &file,
            csv(",", true, "\\N"),
            existing("from_csv", &all_columns(), false),
            OnError::Abort,
        ),
    )
    .await;
    result.unwrap();
    assert_eq!(status.state, ImportState::Done);
    assert_eq!(status.rows_written, 4.0);
    assert_eq!(diff(&db, "public.mixed", "public.from_csv").await, 0);

    // JSON array and NDJSON.
    for (ndjson, name) in [(false, "from_json"), (true, "from_ndjson")] {
        let file = dir.path().join(format!("{name}.json"));
        export_to(&db, "mixed", ExportFormat::Json { ndjson }, &file).await;
        run_all(
            &db,
            &format!("CREATE TABLE {name} (LIKE mixed INCLUDING ALL)"),
            &[],
        )
        .await
        .unwrap();
        let (result, status) = import(
            &db,
            &request(
                &file,
                ImportFormat::Json,
                existing(name, &all_columns(), false),
                OnError::Abort,
            ),
        )
        .await;
        result.unwrap();
        assert_eq!(status.rows_written, 4.0, "{name}");
        assert_eq!(
            diff(&db, "public.mixed", &format!("public.{name}")).await,
            0,
            "{name}"
        );
    }
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn columns_are_mapped_by_name_extra_ones_skipped_and_defaults_used() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = scratch(&dev, "import_map").await;
    run_all(
        &db,
        "CREATE TABLE t (a integer, b text, c text DEFAULT 'dflt', d text)",
        &[],
    )
    .await
    .unwrap();
    let dir = TempDir::new().unwrap();

    // Another order, a column the table doesn't have, `;` between fields, 'x' for NULL.
    let file = dir.path().join("t.csv");
    std::fs::write(
        &file,
        "\u{feff}b;a;extra\nhello;1;zzz\n'q;uoted';2;zzz\nx;3;zzz\n",
    )
    .unwrap();
    let format = ImportFormat::Csv {
        delimiter: ";".into(),
        quote: "'".into(),
        header: true,
        null_text: "x".into(),
    };
    let (result, status) = import(
        &db,
        &request(
            &file,
            format,
            existing("t", &[("a", "a"), ("b", "b")], false),
            OnError::Abort,
        ),
    )
    .await;
    result.unwrap();
    assert_eq!(status.rows_written, 3.0);
    let rows: Vec<(i32, Option<String>, String, Option<String>)> = db
        .meta()
        .await
        .unwrap()
        .query("SELECT a, b, c, d FROM t ORDER BY a", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3)))
        .collect();
    assert_eq!(
        rows,
        [
            (1, Some("hello".into()), "dflt".into(), None),
            (2, Some("q;uoted".into()), "dflt".into(), None),
            (3, None, "dflt".into(), None),
        ]
    );

    // No header row: the columns are column_1, column_2, … and the first row is data.
    run_all(&db, "CREATE TABLE u (a integer, b text)", &[])
        .await
        .unwrap();
    let file = dir.path().join("u.csv");
    std::fs::write(&file, "1,one\n2,two\n").unwrap();
    let (result, status) = import(
        &db,
        &request(
            &file,
            csv(",", false, ""),
            existing("u", &[("column_1", "a"), ("column_2", "b")], false),
            OnError::Abort,
        ),
    )
    .await;
    result.unwrap();
    assert_eq!(status.rows_written, 2.0);

    // A column mapped twice, a missing column, nothing mapped.
    let bad = |pairs: &[(&str, &str)]| {
        request(
            &file,
            csv(",", false, ""),
            existing("u", pairs, false),
            OnError::Abort,
        )
    };
    for (pairs, expected) in [
        (
            vec![("column_1", "a"), ("column_2", "a")],
            "mapped from two",
        ),
        (vec![("column_1", "nope")], "no column"),
        (vec![], "at least one column"),
    ] {
        let (result, _) = import(&db, &bad(&pairs)).await;
        let error = result.unwrap_err();
        assert!(
            error.message().contains(expected),
            "{expected}: {}",
            error.message()
        );
    }
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn truncating_first_keeps_the_old_rows_when_the_import_fails() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = scratch(&dev, "import_truncate").await;
    run_all(
        &db,
        "CREATE TABLE t (a integer); INSERT INTO t VALUES (100), (200)",
        &[],
    )
    .await
    .unwrap();
    let dir = TempDir::new().unwrap();
    let good = dir.path().join("good.csv");
    std::fs::write(&good, "a\n1\n2\n3\n").unwrap();
    let (result, _) = import(
        &db,
        &request(
            &good,
            csv(",", true, ""),
            existing("t", &[("a", "a")], true),
            OnError::Abort,
        ),
    )
    .await;
    result.unwrap();
    assert_eq!(count(&db, "t").await, 3);

    let bad = dir.path().join("bad.csv");
    std::fs::write(&bad, "a\n7\nnot a number\n9\n").unwrap();
    let (result, status) = import(
        &db,
        &request(
            &bad,
            csv(",", true, ""),
            existing("t", &[("a", "a")], true),
            OnError::Abort,
        ),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(
        count(&db, "t").await,
        3,
        "the truncate was rolled back with the rest"
    );
    assert_eq!(status.errors.len(), 1);
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn a_new_table_is_made_from_the_file_with_the_types_it_suggests() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = scratch(&dev, "import_new").await;
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("people.csv");
    std::fs::write(
        &file,
        "id,name,score,active,joined,seen,ref,extra\n\
         1,Ann,1.5,true,2026-01-02,2026-01-02 03:04:05+00,123e4567-e89b-12d3-a456-426614174000,\"{\"\"a\"\": 1}\"\n\
         2,Bob,2,false,2026-02-03,2026-02-03 04:05:06+00,223e4567-e89b-12d3-a456-426614174000,[1]\n",
    )
    .unwrap();
    let shown = preview(&PreviewRequest {
        path: file.display().to_string(),
        format: csv(",", true, ""),
    })
    .unwrap();
    assert_eq!(
        shown.columns,
        [
            "id", "name", "score", "active", "joined", "seen", "ref", "extra"
        ]
    );
    assert_eq!(
        shown.suggested_types,
        [
            "integer",
            "text",
            "numeric",
            "boolean",
            "date",
            "timestamptz",
            "uuid",
            "jsonb"
        ]
    );

    let columns: Vec<NewColumn> = shown
        .columns
        .iter()
        .zip(&shown.suggested_types)
        .map(|(name, ty)| NewColumn {
            source: name.clone(),
            name: name.clone(),
            type_name: ty.clone(),
        })
        .collect();
    let target = ImportTarget::New {
        schema: "public".into(),
        table: "people".into(),
        columns,
    };
    let (result, status) = import(
        &db,
        &request(&file, csv(",", true, ""), target, OnError::Abort),
    )
    .await;
    result.unwrap();
    assert_eq!(status.rows_written, 2.0);
    assert_eq!(status.table.as_deref(), Some("public.people"));
    let types: Vec<String> = db
        .meta()
        .await
        .unwrap()
        .query(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute
              WHERE attrelid = 'public.people'::regclass AND attnum > 0 ORDER BY attnum",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(
        types,
        [
            "integer",
            "text",
            "numeric",
            "boolean",
            "date",
            "timestamp with time zone",
            "uuid",
            "jsonb"
        ]
    );
    // A table that is already there fails, and leaves nothing.
    let again = ImportTarget::New {
        schema: "public".into(),
        table: "people".into(),
        columns: vec![NewColumn {
            source: "id".into(),
            name: "id".into(),
            type_name: "integer".into(),
        }],
    };
    let (result, _) = import(
        &db,
        &request(&file, csv(",", true, ""), again, OnError::Abort),
    )
    .await;
    assert!(result.unwrap_err().message().contains("already exists"));
    // A bad type is refused before anything runs.
    let hostile = ImportTarget::New {
        schema: "public".into(),
        table: "evil".into(),
        columns: vec![NewColumn {
            source: "id".into(),
            name: "id".into(),
            type_name: "int); DROP TABLE people; --".into(),
        }],
    };
    let (result, _) = import(
        &db,
        &request(&file, csv(",", true, ""), hostile, OnError::Abort),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(count(&db, "people").await, 2);
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn a_bad_row_is_reported_with_its_line_in_the_file() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = scratch(&dev, "import_errors").await;
    run_all(
        &db,
        "CREATE TABLE t (id integer, note text, qty integer NOT NULL)",
        &[],
    )
    .await
    .unwrap();
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("t.csv");
    // Line 1 is the header. The record on line 3 has a line break inside, so the bad record
    // is on line 6, though it is only the fifth record.
    let mut text = String::from("id,note,qty\n1,ok,1\n2,\"two\nlines\",2\n3,fine,3\n");
    text.push_str("4,bad,abc\n5,fine,5\n6,,\n");
    std::fs::write(&file, &text).unwrap();
    let target = || {
        existing(
            "t",
            &[("id", "id"), ("note", "note"), ("qty", "qty")],
            false,
        )
    };

    let (result, status) = import(
        &db,
        &request(&file, csv(",", true, ""), target(), OnError::Abort),
    )
    .await;
    let error = result.unwrap_err();
    assert!(
        error.message().starts_with("Line 6:"),
        "{}",
        error.message()
    );
    assert!(
        error.message().contains("abc") && error.message().contains("qty"),
        "{}",
        error.message()
    );
    assert_eq!(count(&db, "t").await, 0, "nothing is kept");
    assert_eq!(status.errors[0].at, "line 6");

    // Skipping: the good rows go in, the bad ones are listed with their lines.
    let (result, status) = import(
        &db,
        &request(&file, csv(",", true, ""), target(), OnError::Skip),
    )
    .await;
    result.unwrap();
    assert_eq!(status.rows_written, 4.0);
    assert_eq!(status.rows_skipped, 2.0);
    let listed: Vec<(&str, bool)> = status
        .errors
        .iter()
        .map(|e| {
            (
                e.at.as_str(),
                e.message.contains("abc") || e.message.contains("null"),
            )
        })
        .collect();
    assert_eq!(listed, [("line 6", true), ("line 8", true)]);
    assert!(
        status.errors[1].message.contains("null value")
            || status.errors[1].message.contains("NOT NULL")
            || status.errors[1].message.contains("not-null"),
        "{}",
        status.errors[1].message
    );
    assert_eq!(count(&db, "t").await, 4);
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn json_errors_name_the_item_and_the_line() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = scratch(&dev, "import_json_err").await;
    run_all(&db, "CREATE TABLE t (id integer, name text)", &[])
        .await
        .unwrap();
    let dir = TempDir::new().unwrap();
    let target = || existing("t", &[("id", "id"), ("name", "name")], false);

    let array = dir.path().join("a.json");
    std::fs::write(
        &array,
        r#"[{"id": 1, "name": "a"}, {"id": "x", "name": "b"}]"#,
    )
    .unwrap();
    let (result, _) = import(
        &db,
        &request(&array, ImportFormat::Json, target(), OnError::Abort),
    )
    .await;
    assert!(result.unwrap_err().message().starts_with("Item 2:"));

    let lines = dir.path().join("l.json");
    std::fs::write(&lines, "{\"id\": 1, \"name\": \"a\"}\n\n{\"id\": \"x\"}\n").unwrap();
    let (result, _) = import(
        &db,
        &request(&lines, ImportFormat::Json, target(), OnError::Abort),
    )
    .await;
    assert!(result.unwrap_err().message().starts_with("Line 3:"));

    // Not an object, not JSON, empty, missing, a broken array.
    for (content, expected) in [
        ("[1, 2]", "not an object"),
        ("hello", "not JSON data"),
        ("", "empty"),
        ("[{\"id\": 1}", "not valid"),
        ("{\"id\": 1}\n{oops\n", "Line 2"),
    ] {
        let file = dir.path().join("bad.json");
        std::fs::write(&file, content).unwrap();
        let (result, _) = import(
            &db,
            &request(&file, ImportFormat::Json, target(), OnError::Abort),
        )
        .await;
        assert!(
            result.unwrap_err().message().contains(expected),
            "{content:?}"
        );
    }
    let (result, _) = import(
        &db,
        &request(
            &dir.path().join("nope.json"),
            ImportFormat::Json,
            target(),
            OnError::Abort,
        ),
    )
    .await;
    assert!(result.unwrap_err().message().contains("There is no file"));
    assert_eq!(count(&db, "t").await, 0);
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn the_preview_shows_the_start_of_the_file() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("big.csv");
    let mut text = String::from("\u{feff}id,,name,id\n");
    for i in 0..120 {
        text.push_str(&format!("{i},x,n{i},y\n"));
    }
    std::fs::write(&file, text).unwrap();
    let shown = preview(&PreviewRequest {
        path: file.display().to_string(),
        format: csv(",", true, ""),
    })
    .unwrap();
    // Unique, never blank, no byte order mark in the first name.
    assert_eq!(shown.columns, ["id", "column_2", "name", "id_2"]);
    assert_eq!(shown.rows.len(), 50);
    assert!(shown.more_rows);
    assert_eq!(
        shown.rows[0],
        [
            Some("0".into()),
            Some("x".into()),
            Some("n0".into()),
            Some("y".into())
        ]
    );
    assert_eq!(shown.suggested_types, ["integer", "text", "text", "text"]);
    assert!(shown.file_bytes > 1000.0);

    // JSON: the keys in order of appearance, nested values as JSON text, missing keys NULL.
    let json = dir.path().join("p.json");
    std::fs::write(&json, r#"[{"a": 1, "b": {"c": [1]}}, {"a": 2, "z": true}]"#).unwrap();
    let shown = preview(&PreviewRequest {
        path: json.display().to_string(),
        format: ImportFormat::Json,
    })
    .unwrap();
    assert_eq!(shown.columns, ["a", "b", "z"]);
    assert_eq!(
        shown.rows[0],
        [Some("1".into()), Some("{\"c\":[1]}".into()), None]
    );
    assert_eq!(shown.rows[1], [Some("2".into()), None, Some("true".into())]);
    assert!(!shown.more_rows);

    // Not UTF-8: it says where.
    let latin = dir.path().join("latin.csv");
    std::fs::write(&latin, b"a,b\n1,caf\xe9\n").unwrap();
    let error = preview(&PreviewRequest {
        path: latin.display().to_string(),
        format: csv(",", true, ""),
    })
    .unwrap_err();
    assert!(
        error.message().contains("Line 2") && error.message().contains("UTF-8"),
        "{}",
        error.message()
    );
    // Settings that make no sense.
    let error = preview(&PreviewRequest {
        path: file.display().to_string(),
        format: csv(",,", true, ""),
    })
    .unwrap_err();
    assert!(error.message().contains("one ASCII character"));
}

#[tokio::test]
async fn cancelling_keeps_nothing() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let dev = Arc::new(dev);
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("metrics.csv");
    export_to(
        &dev,
        "metrics_big",
        ExportFormat::Csv(CsvOptions {
            delimiter: ",".into(),
            quote: "\"".into(),
            header: true,
            null_text: String::new(),
        }),
        &file,
    )
    .await;
    let (scratch, db) = scratch(&dev, "import_cancel").await;
    let db = Arc::new(db);
    run_all(&db, "CREATE TABLE m (id bigint, recorded_at timestamptz, sensor text, value float8, meta jsonb)", &[]).await.unwrap();

    let job = Arc::new(ImportJob::new());
    let task = {
        let (db, job) = (Arc::clone(&db), Arc::clone(&job));
        let request = request(
            &file,
            csv(",", true, ""),
            existing(
                "m",
                &[
                    ("id", "id"),
                    ("recorded_at", "recorded_at"),
                    ("sensor", "sensor"),
                    ("value", "value"),
                    ("meta", "meta"),
                ],
                false,
            ),
            OnError::Abort,
        );
        tokio::spawn(async move {
            let result = import::run(&db, &job, "cancel", &request).await;
            job.finish(result);
        })
    };
    let started = Instant::now();
    while job.snapshot().rows_read == 0.0 {
        assert!(started.elapsed() < Duration::from_secs(20));
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    job.cancel();
    task.await.unwrap();
    let status = job.snapshot();
    assert_eq!(status.state, ImportState::Cancelled);
    assert_eq!(status.rows_written, 0.0);
    assert_eq!(
        count(&db, "m").await,
        0,
        "a cancelled import is rolled back"
    );
    drop(db);
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn a_million_rows_import_in_well_under_thirty_seconds() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("metrics.csv");
    export_to(
        &dev,
        "metrics_big",
        ExportFormat::Csv(CsvOptions {
            delimiter: ",".into(),
            quote: "\"".into(),
            header: true,
            null_text: String::new(),
        }),
        &file,
    )
    .await;
    let (scratch, db) = scratch(&dev, "import_million").await;
    run_all(&db, "CREATE TABLE m (id bigint PRIMARY KEY, recorded_at timestamptz, sensor text, value float8, meta jsonb)", &[]).await.unwrap();

    let started = Instant::now();
    let (result, status) = import(
        &db,
        &request(
            &file,
            csv(",", true, ""),
            existing(
                "m",
                &[
                    ("id", "id"),
                    ("recorded_at", "recorded_at"),
                    ("sensor", "sensor"),
                    ("value", "value"),
                    ("meta", "meta"),
                ],
                false,
            ),
            OnError::Abort,
        ),
    )
    .await;
    let took = started.elapsed();
    result.unwrap();
    eprintln!(
        "imported {} rows in {:.1}s",
        status.rows_written,
        took.as_secs_f64()
    );
    assert_eq!(status.rows_written, 1_000_000.0);
    assert_eq!(count(&db, "m").await, 1_000_000);
    assert!(took < Duration::from_secs(30), "took {took:?}");
    // Same data: compare a checksum of the two tables.
    let sums: (i64, f64) = {
        let a = dev
            .meta()
            .await
            .unwrap()
            .query_one("SELECT sum(id)::bigint, sum(value) FROM metrics_big", &[])
            .await
            .unwrap();
        let b = db
            .meta()
            .await
            .unwrap()
            .query_one("SELECT sum(id)::bigint, sum(value) FROM m", &[])
            .await
            .unwrap();
        assert_eq!(
            a.get::<_, Option<f64>>(1).map(|v| (v * 1000.0).round()),
            b.get::<_, Option<f64>>(1).map(|v| (v * 1000.0).round())
        );
        (b.get::<_, i64>(0), 0.0)
    };
    assert_eq!(sums.0, 500_000_500_000);
    db.close().await;
    scratch.drop_it(&dev).await;
}
