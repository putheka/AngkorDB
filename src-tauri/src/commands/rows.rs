//! Read the rows of a table or view.

use tauri::State;

use crate::db::rows;
use crate::error::AppResult;
use crate::models::rows::{Filter, RowCount, RowPage, RowQuery};
use crate::state::AppState;

/// One page of a table: paging, sorting and filtering happen on the server.
#[tauri::command]
#[specta::specta]
pub async fn fetch_rows(
    state: State<'_, AppState>,
    connection_id: String,
    query: RowQuery,
) -> AppResult<RowPage> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    rows::fetch_rows(&client, &query).await
}

/// How many rows match. The planner's estimate when there are no filters and `exact` is
/// false (instant); otherwise `count(*)`, which scans the table.
#[tauri::command]
#[specta::specta]
pub async fn count_rows(
    state: State<'_, AppState>,
    connection_id: String,
    schema: String,
    table: String,
    filters: Vec<Filter>,
    raw_where: Option<String>,
    exact: bool,
) -> AppResult<RowCount> {
    let session = state.session(&connection_id).await?;
    let client = session.meta().await?;
    rows::count_rows(
        &client,
        &schema,
        &table,
        &filters,
        raw_where.as_deref(),
        exact,
    )
    .await
}
