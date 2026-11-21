//! The SQL editor tab: run scripts, stop them, and find the statement under the cursor.

use tauri::State;

use crate::db::{explain, query, script};
use crate::error::AppResult;
use crate::models::explain::ExplainRun;
use crate::models::query::{QueryRun, StatementOutcome, TextRange};
use crate::state::AppState;
use crate::storage::history;

/// Run the statements of `sql` one after another on the query tab's own connection. A
/// statement that fails ends the run and is reported as the last result.
#[tauri::command]
#[specta::specta]
pub async fn run_query(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
    sql: String,
) -> AppResult<QueryRun> {
    let session = state.session(&connection_id).await?;
    let run = query::run_script(&session, &tab_id, &sql).await?;
    remember(&state, &connection_id, &sql, &run);
    Ok(run)
}

/// Put every statement that was run into the history. Never fails the run: a history that
/// can't be written is not worth an error on a query that worked.
fn remember(state: &AppState, connection_id: &str, sql: &str, run: &QueryRun) {
    let ran_at = history::now_ms();
    let statements = script::split(sql);
    for result in &run.statements {
        let Some(statement) = statements
            .iter()
            .find(|s| s.utf16_start == result.range.start)
        else {
            continue;
        };
        let ok = !matches!(result.outcome, StatementOutcome::Error { .. });
        if let Err(error) = state.history().add(
            connection_id,
            &sql[statement.start..statement.end],
            ran_at,
            result.duration_ms,
            ok,
        ) {
            eprintln!("could not record query history: {error}");
        }
    }
}

/// `EXPLAIN` the one statement in `sql` on the tab's connection. With `analyze` the statement
/// is run (`EXPLAIN (ANALYZE, BUFFERS)`) inside a transaction that is rolled back.
#[tauri::command]
#[specta::specta]
pub async fn explain_query(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
    sql: String,
    analyze: bool,
) -> AppResult<ExplainRun> {
    let session = state.session(&connection_id).await?;
    explain::explain(&session, &tab_id, &sql, analyze).await
}

/// Ask the server to stop what the tab is running. `false` if the tab has no connection yet.
#[tauri::command]
#[specta::specta]
pub async fn cancel_query(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
) -> AppResult<bool> {
    let session = state.session(&connection_id).await?;
    session.cancel_tab(&tab_id).await
}

/// Close the tab's connection. Nothing to do if the connection is already gone.
#[tauri::command]
#[specta::specta]
pub async fn close_query_tab(
    state: State<'_, AppState>,
    connection_id: String,
    tab_id: String,
) -> AppResult<()> {
    if let Ok(session) = state.session(&connection_id).await {
        session.close_tab(&tab_id).await;
    }
    Ok(())
}

/// The statement of `sql` that `cursor` (a UTF-16 offset) is in, or `None` if the text holds
/// none. Used for "run the current statement"; no connection needed.
#[tauri::command]
#[specta::specta]
pub fn statement_at(sql: String, cursor: u32) -> Option<TextRange> {
    let statements = script::split(&sql);
    script::statement_at(&statements, cursor).map(|s| TextRange {
        start: s.utf16_start,
        end: s.utf16_end,
    })
}
