//! Exporting rows to files, for real (see `common`): every format, filters and sort, queries,
//! several tables, cancelling, and that a million rows take no more memory than a few.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use angkordb_lib::db::export::{self, ExportJob};
use angkordb_lib::db::session::Session;
use angkordb_lib::error::AppError;
use angkordb_lib::models::export::{
    CsvOptions, ExportFormat, ExportRequest, ExportSource, ExportState, ExportStatus, QueryExport,
    TableExport, TableRef,
};
use angkordb_lib::models::rows::{Filter, FilterOp, SortDir, SortSpec};
use common::{Scratch, open_or_skip, run_all};
use tempfile::TempDir;

fn csv() -> ExportFormat {
    ExportFormat::Csv(CsvOptions {
        delimiter: ",".into(),
        quote: "\"".into(),
        header: true,
        null_text: String::new(),
    })
}

fn table(schema: &str, name: &str) -> ExportSource {
    ExportSource::Table(TableExport {
        schema: schema.into(),
        table: name.into(),
        filters: vec![],
        raw_where: None,
        sort: vec![],
    })
}

fn request(source: ExportSource, format: ExportFormat, path: &Path) -> ExportRequest {
    ExportRequest {
        source,
        format,
        path: path.display().to_string(),
    }
}

async fn export(session: &Session, request: &ExportRequest) -> Result<ExportStatus, AppError> {
    let job = ExportJob::new();
    let id = uuid::Uuid::new_v4().to_string();
    let result = export::run(session, &job, &id, request).await;
    if let Err(e) = &result {
        // Same as the command does: the failure is recorded, and the caller sees it.
        job.finish(Err(AppError::Internal(e.message())));
        return Err(match result {
            Err(e) => e,
            Ok(()) => unreachable!(),
        });
    }
    job.finish(result);
    Ok(job.snapshot())
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

async fn mixed_db(admin: &Session, label: &str) -> (Scratch, Session) {
    let scratch = Scratch::create(admin, label).await;
    let db = scratch.open().await;
    run_all(&db, MIXED, &[]).await.unwrap();
    (scratch, db)
}

async fn count_diff(db: &Session, a: &str, b: &str) -> i64 {
    let client = db.meta().await.unwrap();
    client
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

#[tokio::test]
async fn csv_is_what_copy_writes() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("users.csv");
    let status = export(&dev, &request(table("public", "users"), csv(), &file))
        .await
        .unwrap();
    assert_eq!(status.state, ExportState::Done);
    assert!(status.rows >= 200.0, "{}", status.rows);
    assert_eq!(status.files, [file.display().to_string()]);

    // The server's own CSV of the same table, in the same order.
    let client = dev.meta().await.unwrap();
    let copy = client
        .copy_out("COPY public.users TO STDOUT WITH (FORMAT csv, HEADER true)")
        .await
        .unwrap();
    let mut expected = Vec::new();
    {
        use futures_util::StreamExt;
        let mut copy = std::pin::pin!(copy);
        while let Some(chunk) = copy.next().await {
            expected.extend_from_slice(&chunk.unwrap());
        }
    }
    let ours = std::fs::read(&file).unwrap();
    assert_eq!(ours.len(), expected.len(), "same size");
    assert_eq!(ours, expected, "byte for byte what COPY writes");
    assert_eq!(status.bytes as usize, ours.len());
    assert!(!dir.path().join("users.csv.part").exists());
}

#[tokio::test]
async fn every_format_round_trips_awkward_values() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = mixed_db(&dev, "export_formats").await;
    let dir = TempDir::new().unwrap();

    // SQL: the INSERTs rebuild the table, value for value.
    let sql_file = dir.path().join("mixed.sql");
    let status = export(
        &db,
        &request(
            table("public", "mixed"),
            ExportFormat::Sql { batch_size: 3 },
            &sql_file,
        ),
    )
    .await
    .unwrap();
    assert_eq!(status.rows, 4.0);
    let sql = std::fs::read_to_string(&sql_file).unwrap();
    assert_eq!(
        sql.matches("INSERT INTO").count(),
        2,
        "4 rows in batches of 3: {sql}"
    );
    run_all(
        &db,
        "CREATE TABLE mixed_copy (LIKE mixed INCLUDING ALL)",
        &[],
    )
    .await
    .unwrap();
    let client = db.meta().await.unwrap();
    client
        .batch_execute(&sql.replace("\"public\".\"mixed\"", "public.mixed_copy"))
        .await
        .unwrap();
    assert_eq!(
        count_diff(&db, "public.mixed", "public.mixed_copy").await,
        0,
        "{sql}"
    );

    // CSV: loaded back with COPY it is the same table too.
    let csv_file = dir.path().join("mixed.csv");
    export(&db, &request(table("public", "mixed"), csv(), &csv_file))
        .await
        .unwrap();
    run_all(
        &db,
        "CREATE TABLE mixed_csv (LIKE mixed INCLUDING ALL)",
        &[],
    )
    .await
    .unwrap();
    let text = std::fs::read(&csv_file).unwrap();
    let sink = client
        .copy_in("COPY public.mixed_csv FROM STDIN WITH (FORMAT csv, HEADER true)")
        .await
        .unwrap();
    {
        use futures_util::SinkExt;
        let mut sink = std::pin::pin!(sink);
        sink.send(bytes_of(&text)).await.unwrap();
        sink.close().await.unwrap();
    }
    assert_eq!(count_diff(&db, "public.mixed", "public.mixed_csv").await, 0);

    // JSON: the typed values come out as JSON types.
    let json_file = dir.path().join("mixed.json");
    export(
        &db,
        &request(
            table("public", "mixed"),
            ExportFormat::Json { ndjson: false },
            &json_file,
        ),
    )
    .await
    .unwrap();
    let rows: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&json_file).unwrap()).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 4);
    assert_eq!(rows[0]["id"], 1);
    assert_eq!(rows[0]["active"], true);
    assert_eq!(rows[0]["price"], 12.5);
    assert_eq!(rows[0]["meta"]["a"][1], 2);
    assert_eq!(rows[0]["tags"], "{x,y}");
    assert_eq!(rows[1]["name"], "O'Brien, \"Bob\"");
    assert_eq!(rows[1]["note"], "two\nlines");
    assert_eq!(rows[2]["ratio"], "NaN");
    assert!(rows[2]["meta"].is_null());
    assert_eq!(rows[3]["name"], "ünïcödé 日本");

    // NDJSON: the same rows, a line each.
    let lines_file = dir.path().join("mixed.ndjson");
    export(
        &db,
        &request(
            table("public", "mixed"),
            ExportFormat::Json { ndjson: true },
            &lines_file,
        ),
    )
    .await
    .unwrap();
    let lines = std::fs::read_to_string(&lines_file).unwrap();
    assert_eq!(lines.lines().count(), 4);
    for (i, line) in lines.lines().enumerate() {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(line).unwrap(),
            rows[i]
        );
    }

    // Markdown.
    let md_file = dir.path().join("mixed.md");
    export(
        &db,
        &request(table("public", "mixed"), ExportFormat::Markdown, &md_file),
    )
    .await
    .unwrap();
    let md = std::fs::read_to_string(&md_file).unwrap();
    assert!(md.starts_with("| id | name |"), "{md}");
    assert!(md.contains("back\\slash \\| pipe"), "{md}");
    assert!(md.contains("two<br>lines"), "{md}");
    assert_eq!(md.lines().count(), 6);

    drop(client);
    db.close().await;
    scratch.drop_it(&dev).await;
}

fn bytes_of(text: &[u8]) -> bytes::Bytes {
    bytes::Bytes::copy_from_slice(text)
}

#[tokio::test]
async fn filters_and_the_sort_of_the_grid_are_applied() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = mixed_db(&dev, "export_filters").await;
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("some.csv");
    let source = ExportSource::Table(TableExport {
        schema: "public".into(),
        table: "mixed".into(),
        filters: vec![Filter {
            column: "id".into(),
            op: FilterOp::Gt,
            values: vec!["1".into()],
        }],
        raw_where: Some("name <> 'ünïcödé 日本'".into()),
        sort: vec![SortSpec {
            column: "id".into(),
            dir: SortDir::Desc,
        }],
    });
    let status = export(&db, &request(source, csv(), &file)).await.unwrap();
    assert_eq!(status.rows, 2.0);
    let text = std::fs::read_to_string(&file).unwrap();
    // Row 3 first, then 2 (its note has a line break, so rows are not lines); row 1 and the
    // "ünïcödé" row are filtered out.
    let (three, two) = (text.find("\n3,"), text.find("\n2,"));
    assert!(three.is_some() && two.is_some() && three < two, "{text}");
    assert!(!text.contains("\n1,") && !text.contains("ünï"), "{text}");
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn a_query_is_exported_and_only_a_query() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = mixed_db(&dev, "export_query").await;
    let dir = TempDir::new().unwrap();
    let query = |sql: &str| {
        ExportSource::Query(QueryExport {
            sql: sql.into(),
            name: Some("squares".into()),
        })
    };

    let file = dir.path().join("squares.sql");
    let status = export(
        &db,
        &request(
            query("WITH x AS (SELECT generate_series(1, 5) AS n) SELECT n, n * n AS square FROM x -- trailing\n;"),
            ExportFormat::Sql { batch_size: 100 },
            &file,
        ),
    )
    .await
    .unwrap();
    assert_eq!(status.rows, 5.0);
    let sql = std::fs::read_to_string(&file).unwrap();
    assert!(
        sql.starts_with("INSERT INTO \"squares\" (\"n\", \"square\") VALUES\n  (1, 1),"),
        "{sql}"
    );

    // Two statements, nothing, something that isn't a query, a statement that changes data.
    let bad = |sql: &str| {
        let db = &db;
        let path = dir.path().join("bad.csv");
        let request = request(query(sql), csv(), &path);
        async move { export(db, &request).await.unwrap_err() }
    };
    assert_eq!(bad("SELECT 1; SELECT 2").await.code(), "VALIDATION");
    assert_eq!(bad("   ").await.code(), "VALIDATION");
    let not_query = bad("DELETE FROM mixed").await;
    assert!(
        not_query
            .message()
            .contains("Only a query that returns rows"),
        "{}",
        not_query.message()
    );
    let data_changing = bad("WITH d AS (DELETE FROM mixed RETURNING *) SELECT * FROM d").await;
    assert!(
        data_changing.pg_code().is_some() || data_changing.code() == "VALIDATION",
        "{data_changing:?}"
    );
    let remaining: i64 = db
        .meta()
        .await
        .unwrap()
        .query_one("SELECT count(*) FROM mixed", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(remaining, 4, "an export must not change data");
    assert!(!dir.path().join("bad.csv").exists());
    assert!(!dir.path().join("bad.csv.part").exists());
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn several_tables_go_to_a_folder_one_file_each() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (scratch, db) = mixed_db(&dev, "export_tables").await;
    run_all(
        &db,
        "CREATE TABLE \"we/ird:name\" (a int); INSERT INTO \"we/ird:name\" VALUES (1), (2)",
        &[],
    )
    .await
    .unwrap();
    let dir = TempDir::new().unwrap();
    let source = ExportSource::Tables {
        tables: vec![
            TableRef {
                schema: "public".into(),
                table: "mixed".into(),
            },
            TableRef {
                schema: "public".into(),
                table: "we/ird:name".into(),
            },
        ],
    };
    let status = export(&db, &request(source, csv(), dir.path()))
        .await
        .unwrap();
    assert_eq!(status.state, ExportState::Done);
    assert_eq!(status.rows, 6.0);
    assert_eq!(status.files.len(), 2);
    assert!(dir.path().join("public.mixed.csv").exists());
    assert!(dir.path().join("public.we_ird_name.csv").exists());

    // A folder that isn't one, and a file where a folder is wanted.
    let not_a_folder = dir.path().join("public.mixed.csv");
    let source = || ExportSource::Tables {
        tables: vec![TableRef {
            schema: "public".into(),
            table: "mixed".into(),
        }],
    };
    let error = export(&db, &request(source(), csv(), &not_a_folder))
        .await
        .unwrap_err();
    assert_eq!(error.code(), "VALIDATION");
    let error = export(
        &db,
        &request(ExportSource::Tables { tables: vec![] }, csv(), dir.path()),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code(), "VALIDATION");
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn bad_destinations_and_bad_filters_are_refused_before_any_file_is_made() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let dir = TempDir::new().unwrap();
    let run = |source: ExportSource, path: String| {
        let dev = &dev;
        async move {
            export(
                dev,
                &ExportRequest {
                    source,
                    format: csv(),
                    path,
                },
            )
            .await
            .unwrap_err()
        }
    };
    let relative = run(table("public", "users"), "users.csv".into()).await;
    assert!(
        relative.message().contains("Choose where to save"),
        "{}",
        relative.message()
    );
    let nowhere = run(
        table("public", "users"),
        "/nonexistent-folder/users.csv".into(),
    )
    .await;
    assert!(
        nowhere.message().contains("does not exist"),
        "{}",
        nowhere.message()
    );
    let folder = run(table("public", "users"), dir.path().display().to_string()).await;
    assert!(
        folder.message().contains("is a folder"),
        "{}",
        folder.message()
    );

    let filter = ExportSource::Table(TableExport {
        schema: "public".into(),
        table: "users".into(),
        filters: vec![Filter {
            column: "no_such_column".into(),
            op: FilterOp::Eq,
            values: vec!["1".into()],
        }],
        raw_where: None,
        sort: vec![],
    });
    let file = dir.path().join("x.csv");
    let error = run(filter, file.display().to_string()).await;
    assert_eq!(error.code(), "VALIDATION");
    let missing = run(table("public", "no_such_table"), file.display().to_string()).await;
    assert_eq!(missing.code(), "NOT_FOUND");
    assert!(
        std::fs::read_dir(dir.path()).unwrap().next().is_none(),
        "files were left behind"
    );
}

#[tokio::test]
async fn cancelling_stops_the_export_and_leaves_no_file() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let dev = Arc::new(dev);
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("big.csv");
    let job = Arc::new(ExportJob::new());
    let task = {
        let (dev, job, request) = (
            Arc::clone(&dev),
            Arc::clone(&job),
            request(table("public", "metrics_big"), csv(), &file),
        );
        tokio::spawn(async move {
            let result = export::run(&dev, &job, "cancel-test", &request).await;
            job.finish(result);
        })
    };
    let started = Instant::now();
    while job.snapshot().rows == 0.0 {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the export never started"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    job.cancel();
    task.await.unwrap();
    let status = job.snapshot();
    assert_eq!(status.state, ExportState::Cancelled);
    assert!(
        status.rows < 1_000_000.0,
        "it did not stop: {}",
        status.rows
    );
    assert!(!file.exists(), "a cancelled export left its file");
    assert!(!dir.path().join("big.csv.part").exists());
    assert!(status.files.is_empty());
}

/// The resident memory of this process, in MB.
fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &std::process::id().to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or(0.0)
        / 1024.0
}

#[tokio::test]
async fn a_million_rows_take_no_more_memory_than_a_few() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let dev = Arc::new(dev);
    let dir = TempDir::new().unwrap();
    // Warm up: connections, buffers and allocator are in place before the baseline.
    let warm = dir.path().join("warm.csv");
    export(&dev, &request(table("public", "users"), csv(), &warm))
        .await
        .unwrap();
    let baseline = rss_mb();

    let file = dir.path().join("metrics.csv");
    let job = Arc::new(ExportJob::new());
    let task = {
        let (dev, job, request) = (
            Arc::clone(&dev),
            Arc::clone(&job),
            request(table("public", "metrics_big"), csv(), &file),
        );
        tokio::spawn(async move {
            let result = export::run(&dev, &job, "memory-test", &request).await;
            job.finish(result);
        })
    };
    let started = Instant::now();
    let mut peak = baseline;
    while !task.is_finished() {
        peak = peak.max(rss_mb());
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    task.await.unwrap();
    let status = job.snapshot();
    assert_eq!(status.state, ExportState::Done, "{:?}", status.error);
    assert_eq!(status.rows, 1_000_000.0);
    let lines = std::fs::read_to_string(&file).unwrap().lines().count();
    assert_eq!(lines, 1_000_001, "a header and a million rows");
    let size_mb = std::fs::metadata(&file).unwrap().len() as f64 / 1_048_576.0;
    let growth = peak - baseline;
    eprintln!(
        "exported 1M rows ({size_mb:.0} MB) in {:.1}s; memory {baseline:.0} MB → peak {peak:.0} MB (+{growth:.0} MB)",
        started.elapsed().as_secs_f64()
    );
    assert!(size_mb > 40.0);
    // The file is bigger than the memory it took.
    assert!(
        growth < 60.0,
        "memory grew by {growth:.0} MB while writing a {size_mb:.0} MB file"
    );
}
