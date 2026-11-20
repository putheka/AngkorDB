//! Safe modes: what a script would do, and proof that the person means it (ANG-25).

use crate::auth;
use crate::db::classify::{self, Kind};
use crate::db::script;
use crate::error::AppResult;
use crate::models::query::{StatementClass, StatementKind, TextRange};

/// What each statement of `sql` does, so the UI can ask before running the ones that change
/// something. Needs no connection.
#[tauri::command]
#[specta::specta]
pub fn classify_sql(sql: String) -> Vec<StatementClass> {
    script::split(&sql)
        .into_iter()
        .map(|statement| {
            let found = classify::classify(&sql[statement.start..statement.end]);
            StatementClass {
                range: TextRange {
                    start: statement.utf16_start,
                    end: statement.utf16_end,
                },
                kind: match found.kind {
                    Kind::Read => StatementKind::Read,
                    Kind::Write => StatementKind::Write,
                    Kind::Schema => StatementKind::Schema,
                },
                command: found.command,
                unlocks_writes: found.unlocks_writes,
            }
        })
        .collect()
}

/// Show the macOS Touch ID / password prompt with `reason` and wait. Succeeds only when the
/// person passed it; cancelling fails with code `CANCELLED`.
#[tauri::command]
#[specta::specta]
pub async fn authenticate_user(reason: String) -> AppResult<()> {
    auth::authenticate(&reason).await
}
