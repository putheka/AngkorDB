//! Backing up and restoring with the real `pg_dump` and `pg_restore` (see `common`).
//! Skipped when this machine has no PostgreSQL client programs, unless `ANGKORDB_REQUIRE_DB=1`.

mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use angkordb_lib::db::backup::{
    Endpoint, ToolJob, detect, major_of, pick, run_backup, run_restore,
};
use angkordb_lib::db::session::Session;
use angkordb_lib::error::AppError;
use angkordb_lib::models::backup::{
    BackupFormat, BackupRequest, PgTools, RestoreRequest, RestoreTarget, ToolState, ToolStatus,
};
use common::{DEV_PASSWORD, Scratch, db_required, dev_config, open_or_skip, run_all};
use tempfile::TempDir;

async fn tools_for(dev: &Session) -> Option<PgTools> {
    let found = detect(None).await;
    if found.is_empty() {
        assert!(
            !db_required(),
            "pg_dump and pg_restore are needed: install postgresql (brew install postgresql@17)"
        );
        eprintln!("SKIPPED: no pg_dump on this machine.");
        return None;
    }
    let server = {
        let client = dev.meta().await.unwrap();
        let row = client.query_one("SHOW server_version", &[]).await.unwrap();
        major_of(&row.get::<_, String>(0))
    };
    Some(pick(&found, server, None).unwrap().clone())
}

fn endpoint(database: &str) -> Endpoint {
    Endpoint::of(
        &dev_config(),
        Some(database),
        Some(DEV_PASSWORD.into()),
        None,
    )
    .unwrap()
}

fn backup_of(path: &Path, format: BackupFormat) -> BackupRequest {
    BackupRequest {
        tools_dir: None,
        database: None,
        path: path.display().to_string(),
        format,
        schema_only: false,
        data_only: false,
        include_tables: vec![],
        exclude_tables: vec![],
        compression: None,
        no_owner: true,
    }
}

fn restore_of(path: &Path, target: RestoreTarget) -> RestoreRequest {
    RestoreRequest {
        tools_dir: None,
        path: path.display().to_string(),
        target,
        clean: false,
        no_owner: true,
        jobs: 1,
    }
}

async fn backup(
    tools: &PgTools,
    request: &BackupRequest,
    endpoint: &Endpoint,
) -> (Result<(), String>, ToolStatus) {
    let job = Arc::new(ToolJob::new());
    let result = run_backup(&job, tools, request, endpoint).await;
    let outcome = result.as_ref().map(|_| ()).map_err(AppError::message);
    job.finish(result);
    (outcome, job.snapshot())
}

async fn restore(
    dev: &Session,
    tools: &PgTools,
    request: &RestoreRequest,
    endpoint: Endpoint,
) -> (Result<(), String>, ToolStatus) {
    let job = Arc::new(ToolJob::new());
    let admin = dev.meta().await.unwrap();
    let result = run_restore(&job, tools, request, endpoint, &admin).await;
    let outcome = result.as_ref().map(|_| ()).map_err(AppError::message);
    job.finish(result);
    (outcome, job.snapshot())
}

fn name(label: &str) -> String {
    format!("angkordb_ddl_{}_{label}", std::process::id())
}

async fn counts(db: &Session) -> Vec<(String, i64)> {
    let client = db.meta().await.unwrap();
    let tables = client
        .query(
            "SELECT schemaname || '.' || tablename FROM pg_tables
              WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1",
            &[],
        )
        .await
        .unwrap();
    let mut out = Vec::new();
    for row in tables {
        let table: String = row.get(0);
        let n: i64 = client
            .query_one(&format!("SELECT count(*) FROM {table}"), &[])
            .await
            .unwrap()
            .get(0);
        out.push((table, n));
    }
    out
}

async fn open(database: &str) -> Session {
    let mut config = dev_config();
    config.database = database.into();
    Session::open(config, Some(DEV_PASSWORD)).await.unwrap()
}

async fn drop_db(dev: &Session, database: &str) {
    let _ = dev
        .meta()
        .await
        .unwrap()
        .batch_execute(&format!(
            "DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)"
        ))
        .await;
}

#[tokio::test]
async fn the_programs_are_found_with_their_versions_newest_first() {
    let found = detect(None).await;
    if found.is_empty() {
        assert!(!db_required(), "no pg_dump on this machine");
        return;
    }
    assert!(
        found
            .iter()
            .all(|t| Path::new(&t.dir).join("pg_dump").exists() && t.major >= 9)
    );
    assert!(found.windows(2).all(|w| w[0].major >= w[1].major));
    assert!(found[0].version.starts_with(&found[0].major.to_string()));
    // A folder that has nothing in it adds nothing; a folder with the programs is tried first.
    assert_eq!(detect(Some("/nonexistent/bin")).await.len(), found.len());
    let first = &found[0];
    let again = detect(Some(&first.dir)).await;
    assert_eq!(again[0].source, "Chosen folder");
    assert_eq!(
        again.len(),
        found.len(),
        "the same programs are not listed twice"
    );
}

#[tokio::test]
async fn backing_up_the_dev_database_and_restoring_it_into_a_new_one_gives_the_same_rows() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let Some(tools) = tools_for(&dev).await else {
        return;
    };
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("dev.dump");

    let started = Instant::now();
    let (result, status) = backup(
        &tools,
        &backup_of(&file, BackupFormat::Custom),
        &endpoint("angkordb_dev"),
    )
    .await;
    result.unwrap();
    assert_eq!(status.state, ToolState::Done);
    assert!(std::fs::read(&file).unwrap().starts_with(b"PGDMP"));
    assert!(status.bytes > 1_000_000.0, "{}", status.bytes);
    assert!(
        status.lines > 10.0
            && status
                .log
                .iter()
                .any(|l| l.contains("dumping contents of table"))
    );
    assert!(status.command.starts_with("pg_dump ") && !status.command.contains("PGPASSWORD"));
    assert_eq!(
        status.output.as_deref(),
        Some(file.display().to_string().as_str())
    );
    assert!(!dir.path().join("dev.dump.part").exists());

    let copy = name("restored");
    drop_db(&dev, &copy).await;
    let request = RestoreRequest {
        jobs: 4,
        ..restore_of(
            &file,
            RestoreTarget::New {
                database: copy.clone(),
            },
        )
    };
    let (result, status) = restore(&dev, &tools, &request, endpoint("angkordb_dev")).await;
    result.unwrap();
    assert_eq!(status.output.as_deref(), Some(copy.as_str()));
    eprintln!(
        "backup and restore of the dev database took {:.1}s",
        started.elapsed().as_secs_f64()
    );

    let restored = open(&copy).await;
    let (before, after) = (counts(&dev).await, counts(&restored).await);
    assert!(
        before.len() >= 8
            && before
                .iter()
                .any(|(t, n)| t == "public.metrics_big" && *n == 1_000_000)
    );
    assert_eq!(before, after, "row counts differ");
    assert_eq!(
        objects(&dev).await,
        objects(&restored).await,
        "indexes, functions, views, sequences differ"
    );
    restored.close().await;
    drop_db(&dev, &copy).await;
}

/// How many indexes, functions, views and sequences the public schema has.
async fn objects(db: &Session) -> Vec<i64> {
    let row = db
        .meta()
        .await
        .unwrap()
        .query_one(
            "SELECT (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'),
                    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public'),
                    (SELECT count(*) FROM pg_views WHERE schemaname = 'public'),
                    (SELECT count(*) FROM pg_sequences WHERE schemaname = 'public')",
            &[],
        )
        .await
        .unwrap();
    (0..4).map(|i| row.get(i)).collect()
}

const SMALL: &str = "
CREATE TABLE mixed (id bigint PRIMARY KEY, name text, born timestamptz, meta jsonb, raw bytea);
INSERT INTO mixed VALUES (1, 'a', '2026-01-02 03:04:05+00', '{\"k\": 1}', '\\xdeadbeef'),
  (2, E'two\\nlines, \"q\"', NULL, NULL, NULL), (3, 'ünï', 'infinity', '[]', '\\x');
CREATE TABLE logs (n int); INSERT INTO logs SELECT generate_series(1, 50);
CREATE VIEW mixed_names AS SELECT name FROM mixed;
";

async fn small(dev: &Session, label: &str) -> (Scratch, Session) {
    let scratch = Scratch::create(dev, label).await;
    let db = scratch.open().await;
    run_all(&db, SMALL, &[]).await.unwrap();
    (scratch, db)
}

#[tokio::test]
async fn every_format_restores_into_a_new_database() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let Some(tools) = tools_for(&dev).await else {
        return;
    };
    let (scratch, db) = small(&dev, "backup_formats").await;
    let source = Scratch {
        name: scratch.name.clone(),
    };
    let dir = TempDir::new().unwrap();
    let want = counts(&db).await;
    for (format, file) in [
        (BackupFormat::Custom, "a.dump"),
        (BackupFormat::Plain, "a.sql"),
        (BackupFormat::Directory, "a_dir"),
        (BackupFormat::Tar, "a.tar"),
    ] {
        let path = dir.path().join(file);
        let (result, _) = backup(&tools, &backup_of(&path, format), &endpoint(&source.name)).await;
        result.unwrap_or_else(|e| panic!("{file}: {e}"));
        assert!(path.exists(), "{file}");
        let copy = name(&format!("fmt_{}", file.replace('.', "_")));
        drop_db(&dev, &copy).await;
        let (result, _) = restore(
            &dev,
            &tools,
            &restore_of(
                &path,
                RestoreTarget::New {
                    database: copy.clone(),
                },
            ),
            endpoint(&source.name),
        )
        .await;
        result.unwrap_or_else(|e| panic!("{file}: {e}"));
        let restored = open(&copy).await;
        assert_eq!(counts(&restored).await, want, "{file}");
        // The data is the same value for value, not only the same count.
        let same: i64 = restored
            .meta()
            .await
            .unwrap()
            .query_one("SELECT count(*) FROM mixed WHERE id = 2 AND name = E'two\\nlines, \"q\"' AND meta IS NULL", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(same, 1, "{file}");
        restored.close().await;
        drop_db(&dev, &copy).await;
    }
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn schema_only_and_table_filters_are_honoured() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let Some(tools) = tools_for(&dev).await else {
        return;
    };
    let (scratch, db) = small(&dev, "backup_filters").await;
    let dir = TempDir::new().unwrap();

    let file = dir.path().join("schema.dump");
    let request = BackupRequest {
        schema_only: true,
        ..backup_of(&file, BackupFormat::Custom)
    };
    backup(&tools, &request, &endpoint(&scratch.name))
        .await
        .0
        .unwrap();
    let copy = name("schema_only");
    drop_db(&dev, &copy).await;
    restore(
        &dev,
        &tools,
        &restore_of(
            &file,
            RestoreTarget::New {
                database: copy.clone(),
            },
        ),
        endpoint(&scratch.name),
    )
    .await
    .0
    .unwrap();
    let restored = open(&copy).await;
    assert_eq!(
        counts(&restored).await,
        [
            ("public.logs".to_owned(), 0),
            ("public.mixed".to_owned(), 0)
        ]
    );
    restored.close().await;
    drop_db(&dev, &copy).await;

    // Only one table, then everything but one.
    let only = dir.path().join("only.dump");
    let request = BackupRequest {
        include_tables: vec!["public.mixed".into()],
        ..backup_of(&only, BackupFormat::Custom)
    };
    backup(&tools, &request, &endpoint(&scratch.name))
        .await
        .0
        .unwrap();
    let copy = name("only");
    drop_db(&dev, &copy).await;
    restore(
        &dev,
        &tools,
        &restore_of(
            &only,
            RestoreTarget::New {
                database: copy.clone(),
            },
        ),
        endpoint(&scratch.name),
    )
    .await
    .0
    .unwrap();
    let restored = open(&copy).await;
    assert_eq!(counts(&restored).await, [("public.mixed".to_owned(), 3)]);
    restored.close().await;
    drop_db(&dev, &copy).await;

    let without = dir.path().join("without.sql");
    let request = BackupRequest {
        exclude_tables: vec!["public.logs".into()],
        ..backup_of(&without, BackupFormat::Plain)
    };
    backup(&tools, &request, &endpoint(&scratch.name))
        .await
        .0
        .unwrap();
    let text = std::fs::read_to_string(&without).unwrap();
    assert!(
        text.contains("CREATE TABLE public.mixed") && !text.contains("public.logs"),
        "{text}"
    );
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn restoring_over_a_database_with_drop_first_puts_the_backup_back() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let Some(tools) = tools_for(&dev).await else {
        return;
    };
    let (scratch, db) = small(&dev, "backup_clean").await;
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("a.dump");
    backup(
        &tools,
        &backup_of(&file, BackupFormat::Custom),
        &endpoint(&scratch.name),
    )
    .await
    .0
    .unwrap();
    run_all(
        &db,
        "DELETE FROM mixed; DROP TABLE logs; CREATE TABLE extra (a int)",
        &[],
    )
    .await
    .unwrap();

    // Without "drop first" the tables that are there make it fail, and it says so.
    let target = RestoreTarget::Existing {
        database: scratch.name.clone(),
    };
    let (result, status) = restore(
        &dev,
        &tools,
        &restore_of(&file, target.clone()),
        endpoint("angkordb_dev"),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(status.state, ToolState::Failed);
    assert!(
        status
            .error
            .as_ref()
            .unwrap()
            .message
            .contains("already exists"),
        "{:?}",
        status.error
    );

    let request = RestoreRequest {
        clean: true,
        ..restore_of(&file, target)
    };
    let (result, _) = restore(&dev, &tools, &request, endpoint("angkordb_dev")).await;
    result.unwrap();
    assert_eq!(
        counts(&db).await,
        [
            ("public.extra".to_owned(), 0),
            ("public.logs".to_owned(), 50),
            ("public.mixed".to_owned(), 3)
        ]
    );
    db.close().await;
    scratch.drop_it(&dev).await;
}

#[tokio::test]
async fn cancelling_a_backup_leaves_no_file() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let Some(tools) = tools_for(&dev).await else {
        return;
    };
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("big.dump");
    let job = Arc::new(ToolJob::new());
    let task = {
        let (job, tools) = (Arc::clone(&job), tools.clone());
        let request = backup_of(&file, BackupFormat::Custom);
        tokio::spawn(async move {
            let result = run_backup(&job, &tools, &request, &endpoint("angkordb_dev")).await;
            job.finish(result);
        })
    };
    let started = Instant::now();
    while job.snapshot().lines == 0.0 {
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "pg_dump never printed"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    job.cancel();
    task.await.unwrap();
    let status = job.snapshot();
    assert_eq!(status.state, ToolState::Cancelled);
    assert!(!file.exists() && !dir.path().join("big.dump.part").exists());
}

#[tokio::test]
async fn failures_are_explained_and_leave_nothing_behind() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let Some(tools) = tools_for(&dev).await else {
        return;
    };
    let dir = TempDir::new().unwrap();

    // A wrong password.
    let file = dir.path().join("x.dump");
    let wrong = Endpoint::of(
        &dev_config(),
        Some("angkordb_dev"),
        Some("nope".into()),
        None,
    )
    .unwrap();
    let (result, status) = backup(&tools, &backup_of(&file, BackupFormat::Custom), &wrong).await;
    let message = result.unwrap_err();
    assert!(
        message.contains("password authentication failed"),
        "{message}"
    );
    assert_eq!(status.state, ToolState::Failed);
    assert!(!file.exists() && !dir.path().join("x.dump.part").exists());

    // A database that is not there.
    let (result, _) = backup(
        &tools,
        &backup_of(&file, BackupFormat::Custom),
        &endpoint("angkordb_no_such_db"),
    )
    .await;
    assert!(result.unwrap_err().contains("does not exist"));

    // Destinations that can't work, before the program starts.
    let request = |path: &str, format| backup_of(Path::new(path), format);
    let (result, status) = backup(
        &tools,
        &request("relative.dump", BackupFormat::Custom),
        &endpoint("angkordb_dev"),
    )
    .await;
    assert!(result.unwrap_err().contains("Choose where"));
    assert_eq!(status.lines, 0.0);
    let (result, _) = backup(
        &tools,
        &request("/nonexistent-folder/x.dump", BackupFormat::Custom),
        &endpoint("angkordb_dev"),
    )
    .await;
    assert!(result.unwrap_err().contains("does not exist"));
    let (result, _) = backup(
        &tools,
        &request(&dir.path().display().to_string(), BackupFormat::Directory),
        &endpoint("angkordb_dev"),
    )
    .await;
    assert!(result.unwrap_err().contains("not there yet"));
    let (result, _) = backup(
        &tools,
        &request(&dir.path().display().to_string(), BackupFormat::Custom),
        &endpoint("angkordb_dev"),
    )
    .await;
    assert!(result.unwrap_err().contains("is a folder"));

    // A restore of something that is not a backup: the database that was made for it is dropped.
    let junk = dir.path().join("junk.sql");
    std::fs::write(&junk, "THIS IS NOT SQL;\n").unwrap();
    let copy = name("junk");
    drop_db(&dev, &copy).await;
    let (result, status) = restore(
        &dev,
        &tools,
        &restore_of(
            &junk,
            RestoreTarget::New {
                database: copy.clone(),
            },
        ),
        endpoint("angkordb_dev"),
    )
    .await;
    assert!(result.unwrap_err().contains("syntax error"));
    assert_eq!(status.state, ToolState::Failed);
    let there: i64 = dev
        .meta()
        .await
        .unwrap()
        .query_one(
            "SELECT count(*) FROM pg_database WHERE datname = $1",
            &[&copy],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        there, 0,
        "the database made for the restore was left behind"
    );

    // A new database that exists already.
    let (result, _) = restore(
        &dev,
        &tools,
        &restore_of(
            &junk,
            RestoreTarget::New {
                database: "angkordb_dev".into(),
            },
        ),
        endpoint("angkordb_dev"),
    )
    .await;
    assert_eq!(
        result.unwrap_err(),
        "database \"angkordb_dev\" already exists"
    );
    let still: i64 = counts(&dev).await.len() as i64;
    assert!(
        still > 0,
        "an existing database must not be dropped by a failed restore"
    );
}
