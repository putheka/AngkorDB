//! EXPLAIN / EXPLAIN ANALYZE of one statement, against the dev database (see `common`).

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use angkordb_lib::db::explain::explain;
use angkordb_lib::db::query::run_script;
use angkordb_lib::db::session::Session;
use angkordb_lib::error::AppError;
use angkordb_lib::models::connection::SafeMode;
use angkordb_lib::models::explain::{ExplainOutcome, ExplainRun};
use angkordb_lib::models::query::{QueryRun, StatementKind, StatementOutcome};
use common::{DEV_PASSWORD, dev_config, open_or_skip};
use serde_json::Value;

/// The plan inside `EXPLAIN (FORMAT JSON)`'s value: `[{"Plan": {...}, ...}]` → the first entry.
fn plan(run: &ExplainRun) -> Value {
    let ExplainOutcome::Plan { json } = &run.outcome else {
        panic!("expected a plan, got {:?}", run.outcome);
    };
    let parsed: Value = serde_json::from_str(json).expect("the plan is JSON");
    parsed[0].clone()
}

async fn run(session: &Session, tab: &str, sql: &str) -> QueryRun {
    run_script(session, tab, sql)
        .await
        .unwrap_or_else(|e| panic!("run {sql:?}: {e:?}"))
}

/// Did the last statement of the run say "there is no transaction in progress"?
async fn is_outside_a_transaction(session: &Session, tab: &str) -> bool {
    let result = run(session, tab, "COMMIT").await;
    result.statements[0]
        .notices
        .iter()
        .any(|n| n.message.contains("no transaction in progress"))
}

#[tokio::test]
async fn a_plain_explain_gives_the_plan_without_running_anything() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let run = explain(
        &session,
        "e1",
        "SELECT * FROM public.users WHERE id = 1",
        false,
    )
    .await
    .unwrap();
    assert!(!run.analyzed);
    assert!(!run.rolled_back);
    assert_eq!(run.command, "SELECT");
    assert_eq!(run.statement_kind, StatementKind::Read);

    let plan = plan(&run);
    assert!(plan["Plan"]["Node Type"].is_string());
    assert!(plan["Plan"]["Total Cost"].is_number());
    assert!(plan["Plan"]["Plan Rows"].is_number());
    assert!(
        plan.get("Execution Time").is_none(),
        "a plain EXPLAIN does not run the statement"
    );
    assert!(plan["Plan"].get("Actual Rows").is_none());
}

#[tokio::test]
async fn explain_analyze_runs_it_and_reports_actual_rows_time_and_buffers() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let run = explain(
        &session,
        "e2",
        "SELECT * FROM public.users WHERE id < 50",
        true,
    )
    .await
    .unwrap();
    assert!(run.analyzed);
    let plan = plan(&run);
    assert!(plan["Execution Time"].is_number());
    assert!(plan["Planning Time"].is_number());
    assert!(plan["Plan"]["Actual Rows"].is_number());
    assert!(plan["Plan"]["Actual Total Time"].is_number());
    assert!(plan["Plan"]["Actual Loops"].is_number());
    assert!(
        plan["Plan"]["Shared Hit Blocks"].is_number(),
        "BUFFERS is on"
    );
}

#[tokio::test]
async fn analyzing_a_write_changes_nothing_and_leaves_no_transaction_open() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let before = run(
        &session,
        "e3",
        "SELECT count(*) FROM public.short_codes WHERE label = '__explain__'",
    )
    .await;

    let result = explain(
        &session,
        "e3",
        "UPDATE public.short_codes SET label = '__explain__'",
        true,
    )
    .await
    .unwrap();
    assert!(result.rolled_back);
    assert_eq!(result.statement_kind, StatementKind::Write);
    assert_eq!(result.command, "UPDATE");
    assert_eq!(plan(&result)["Plan"]["Node Type"], "ModifyTable");

    let after = run(
        &session,
        "e3",
        "SELECT count(*) FROM public.short_codes WHERE label = '__explain__'",
    )
    .await;
    let count = |r: &QueryRun| match &r.statements[0].outcome {
        StatementOutcome::Rows { rows, .. } => rows[0][0].clone(),
        other => panic!("{other:?}"),
    };
    assert_eq!(count(&before), Some("0".into()));
    assert_eq!(
        count(&after),
        Some("0".into()),
        "the update was rolled back"
    );
    assert!(is_outside_a_transaction(&session, "e3").await);
}

#[tokio::test]
async fn analyzing_inside_the_persons_own_transaction_keeps_that_transaction() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    run(
        &session,
        "e4",
        "BEGIN; CREATE TEMP TABLE explain_t (a int); INSERT INTO explain_t VALUES (1)",
    )
    .await;

    let result = explain(&session, "e4", "INSERT INTO explain_t VALUES (2)", true)
        .await
        .unwrap();
    assert!(result.rolled_back);
    assert!(matches!(result.outcome, ExplainOutcome::Plan { .. }));

    // Their insert is there, ours is gone, and their transaction is still open.
    let count = run(&session, "e4", "SELECT count(*) FROM explain_t").await;
    let StatementOutcome::Rows { rows, .. } = &count.statements[0].outcome else {
        panic!("{:?}", count.statements[0].outcome);
    };
    assert_eq!(rows[0][0], Some("1".into()));
    assert!(
        !is_outside_a_transaction(&session, "e4").await,
        "COMMIT ended the person's transaction, so it was still open"
    );
}

#[tokio::test]
async fn a_failing_analyzed_statement_is_an_error_result_and_the_tab_keeps_working() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = explain(&session, "e5", "SELECT 1/0", true).await.unwrap();
    let ExplainOutcome::Error { error, .. } = &result.outcome else {
        panic!("{:?}", result.outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("22012"), "division_by_zero");

    // Not stuck in an aborted transaction.
    let next = run(&session, "e5", "SELECT 'ok'").await;
    assert!(matches!(
        next.statements[0].outcome,
        StatementOutcome::Rows { .. }
    ));
    assert!(is_outside_a_transaction(&session, "e5").await);
}

#[tokio::test]
async fn an_error_points_into_the_text_even_after_emoji() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    // Not 1-based characters of "EXPLAIN (FORMAT JSON) …": an offset into the text given.
    let sql = "  \nSELECT 'é😀' AS x FROM no_such_table";
    let result = explain(&session, "e6", sql, false).await.unwrap();
    let ExplainOutcome::Error { error, offset } = &result.outcome else {
        panic!("{:?}", result.outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("42P01"), "undefined_table");

    let at = sql.find("no_such_table").unwrap();
    let utf16: u32 = sql[..at].chars().map(|c| c.len_utf16() as u32).sum();
    assert_eq!(*offset, Some(utf16));
    // The 1-based position is now in the statement's own characters.
    assert_eq!(
        error.position,
        Some(u32::try_from(sql[..at].chars().count()).unwrap() + 1 - 3)
    );
}

#[tokio::test]
async fn it_needs_exactly_one_statement_that_is_not_already_an_explain() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    for (sql, expect) in [
        ("   ", "no SQL to explain"),
        ("-- only a comment", "no SQL to explain"),
        ("SELECT 1; SELECT 2", "one statement at a time"),
        ("EXPLAIN SELECT 1", "already starts with EXPLAIN"),
        ("explain (analyze) select 1", "already starts with EXPLAIN"),
    ] {
        let err = explain(&session, "e7", sql, false).await.unwrap_err();
        assert!(matches!(err, AppError::Validation(_)), "{sql}: {err:?}");
        assert!(err.message().contains(expect), "{sql}: {}", err.message());
    }
}

#[tokio::test]
async fn a_read_only_connection_cannot_analyze_a_write_or_unlock_itself() {
    if open_or_skip().await.is_none() {
        return;
    }
    let mut config = dev_config();
    config.safe_mode = SafeMode::ReadOnly;
    let session = Session::open(config, Some(DEV_PASSWORD)).await.unwrap();

    // The server refuses the write inside the analyzed transaction.
    let result = explain(
        &session,
        "ro",
        "UPDATE public.short_codes SET label = label",
        true,
    )
    .await
    .unwrap();
    let ExplainOutcome::Error { error, .. } = &result.outcome else {
        panic!("{:?}", result.outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("25006"));

    // A DO block could switch read-only off for the session: it is not sent at all.
    let err = explain(&session, "ro", "DO $$ BEGIN NULL; END $$", true)
        .await
        .unwrap_err();
    assert!(matches!(err, AppError::Validation(_)), "{err:?}");
    // A plain EXPLAIN never runs it, so there is nothing to refuse.
    let planned = explain(
        &session,
        "ro",
        "UPDATE public.short_codes SET label = label",
        false,
    )
    .await
    .unwrap();
    assert!(matches!(planned.outcome, ExplainOutcome::Plan { .. }));
}

#[tokio::test]
async fn analyze_on_a_million_row_table_shows_the_scan_that_cost_the_time() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let run = explain(
        &session,
        "e9",
        "SELECT count(*) FROM public.metrics_big WHERE value > 99.99",
        true,
    )
    .await
    .unwrap();
    let text = serde_json::to_string(&plan(&run)).unwrap();
    assert!(text.contains("\"Relation Name\":\"metrics_big\""), "{text}");
    assert!(text.contains("Seq Scan"), "{text}");
    // The scan read about a million rows (some were filtered out).
    assert!(text.contains("Rows Removed by Filter"), "{text}");
}

#[tokio::test]
async fn cancelling_an_analyzed_statement_is_quick_and_leaves_the_tab_usable() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let session = Arc::new(session);
    let runner = {
        let session = Arc::clone(&session);
        tokio::spawn(async move { explain(&session, "slow", "SELECT pg_sleep(60)", true).await })
    };
    tokio::time::sleep(Duration::from_millis(500)).await;

    let asked = Instant::now();
    assert!(session.cancel_tab("slow").await.unwrap());
    let result = tokio::time::timeout(Duration::from_secs(5), runner)
        .await
        .expect("the explain did not stop within 5 s")
        .unwrap()
        .unwrap();
    assert!(asked.elapsed() < Duration::from_secs(1));
    let ExplainOutcome::Error { error, .. } = &result.outcome else {
        panic!("{:?}", result.outcome);
    };
    assert_eq!(error.pg_code.as_deref(), Some("57014"));
    assert!(is_outside_a_transaction(&session, "slow").await);
}
