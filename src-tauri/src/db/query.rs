//! Run SQL typed into a query tab on that tab's own connection (ANG-20, ANG-8 D3/D4).
//!
//! The text is split into statements ([`script`]) and run one after another; the first error
//! stops the script. Each statement goes through two steps:
//!
//! 1. `prepare`: the server parses it, which gives the column names and types of a `SELECT`
//!    (the simple protocol sends names only) and a precise error position for a syntax error.
//! 2. the simple query protocol: every value arrives as text, the same for every type.
//!
//! Because the tab keeps one connection, `SET`, temp tables and an open transaction last from
//! one run to the next.

use std::time::Instant;

use futures_util::StreamExt;
use tokio_postgres::{Client, SimpleQueryMessage};

use crate::db::classify;
use crate::db::script::{self, Statement};
use crate::db::session::Session;
use crate::error::{AppError, AppErrorPayload, AppResult};
use crate::models::connection::SafeMode;
use crate::models::query::{QueryRun, StatementOutcome, StatementResult, TextRange};
use crate::models::rows::ResultColumn;

/// Rows kept per statement. More are not read: the query is cancelled, so a `SELECT *` on a
/// huge table neither fills memory nor keeps the connection busy.
pub const MAX_ROWS: usize = 10_000;

/// Postgres OID of `boolean`. The simple protocol sends `t` / `f`.
const BOOL_OID: u32 = 16;
/// `text`, for columns whose type we don't know.
const TEXT_OID: u32 = 25;
/// SQLSTATE of a cancelled query.
const QUERY_CANCELED: &str = "57014";

/// Run every statement of `sql` on the tab's connection. Only a failure to get a connection is
/// an `Err`; a statement that fails is the last entry of the result.
pub async fn run_script(session: &Session, tab_id: &str, sql: &str) -> AppResult<QueryRun> {
    let client = session.tab_client(tab_id).await?;
    let started = Instant::now();

    let read_only = session.config().safe_mode == SafeMode::ReadOnly;
    let mut statements = Vec::new();
    for statement in script::split(sql) {
        // The server refuses writes on a read-only connection, but a statement could switch
        // that off for the session; those are not sent.
        let result = if read_only
            && classify::classify(&sql[statement.start..statement.end]).unlocks_writes
        {
            blocked(&statement)
        } else {
            run_statement(session, tab_id, &client, sql, &statement).await
        };
        let failed = matches!(result.outcome, StatementOutcome::Error { .. });
        statements.push(result);
        if failed {
            break;
        }
    }
    Ok(QueryRun {
        statements,
        duration_ms: millis(started),
    })
}

/// The result shown for a statement a read-only connection refuses to send.
fn blocked(statement: &Statement) -> StatementResult {
    let error = AppError::Validation(
        "This connection is read-only, so a statement that could make the session writable is \
         not run. Change the connection's safe mode to write."
            .into(),
    );
    StatementResult {
        range: TextRange {
            start: statement.utf16_start,
            end: statement.utf16_end,
        },
        duration_ms: 0,
        notices: Vec::new(),
        outcome: StatementOutcome::Error {
            error: AppErrorPayload::from(&error),
            offset: Some(statement.utf16_start),
        },
    }
}

async fn run_statement(
    session: &Session,
    tab_id: &str,
    client: &Client,
    sql: &str,
    statement: &Statement,
) -> StatementResult {
    let text = &sql[statement.start..statement.end];
    let started = Instant::now();
    let outcome = match execute(session, tab_id, client, text).await {
        Ok(outcome) => outcome,
        Err(error) => error_outcome(&error, text, statement.utf16_start),
    };
    StatementResult {
        range: TextRange {
            start: statement.utf16_start,
            end: statement.utf16_end,
        },
        duration_ms: millis(started),
        outcome,
        notices: session.take_notices(tab_id),
    }
}

async fn execute(
    session: &Session,
    tab_id: &str,
    client: &Client,
    text: &str,
) -> AppResult<StatementOutcome> {
    let prepared = client.prepare(text).await?;
    let mut columns: Vec<ResultColumn> = prepared
        .columns()
        .iter()
        .map(|c| ResultColumn {
            name: c.name().to_owned(),
            type_oid: c.type_().oid(),
            type_name: c.type_().name().to_owned(),
        })
        .collect();
    drop(prepared);

    let mut stream = std::pin::pin!(client.simple_query_raw(text).await?);
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut affected = 0u64;
    let mut returned_rows = !columns.is_empty();
    let mut truncated = false;

    while let Some(message) = stream.next().await {
        let message = match message {
            Ok(message) => message,
            // We cancelled it ourselves after the row cap: that's the expected end.
            Err(e) if truncated && is_canceled(&e) => break,
            Err(e) => return Err(e.into()),
        };
        match message {
            SimpleQueryMessage::RowDescription(described) => {
                returned_rows = true;
                if columns.is_empty() {
                    columns = described
                        .iter()
                        .map(|c| ResultColumn {
                            name: c.name().to_owned(),
                            type_oid: TEXT_OID,
                            type_name: "text".to_owned(),
                        })
                        .collect();
                }
            }
            SimpleQueryMessage::Row(row) if !truncated => {
                if rows.len() >= MAX_ROWS {
                    truncated = true;
                    // Keep reading until the server confirms it stopped, so the connection is
                    // idle again for the next statement; what arrives meanwhile is dropped.
                    session.cancel_tab(tab_id).await?;
                    continue;
                }
                let mut cells = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    let value = row.try_get(i)?;
                    let is_bool = columns.get(i).is_some_and(|c| c.type_oid == BOOL_OID);
                    cells.push(value.map(|v| match (is_bool, v) {
                        (true, "t") => "true".to_owned(),
                        (true, "f") => "false".to_owned(),
                        _ => v.to_owned(),
                    }));
                }
                rows.push(cells);
            }
            SimpleQueryMessage::CommandComplete(count) => affected = count,
            _ => {}
        }
    }

    Ok(if returned_rows {
        StatementOutcome::Rows {
            columns,
            rows,
            truncated,
        }
    } else {
        StatementOutcome::Command {
            command: command_word(text),
            affected: u32::try_from(affected).unwrap_or(u32::MAX),
        }
    })
}

/// Did the server stop this query because of a cancel request?
fn is_canceled(error: &tokio_postgres::Error) -> bool {
    error
        .code()
        .is_some_and(|code| code.code() == QUERY_CANCELED)
}

/// The first word of the statement in capitals (`UPDATE`, `CREATE`), skipping comments.
pub(crate) fn command_word(text: &str) -> String {
    let mut rest = text;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            break;
        }
    }
    rest.split(|c: char| !c.is_alphabetic())
        .next()
        .unwrap_or("")
        .to_uppercase()
}

/// A failed statement as the UI shows it. The server's position (1-based, in characters of the
/// statement) becomes an offset into the whole script, in UTF-16 units.
fn error_outcome(error: &AppError, statement_text: &str, statement_start: u32) -> StatementOutcome {
    let payload = AppErrorPayload::from(error);
    let offset = payload.position.map(|position| {
        let before: u32 = statement_text
            .chars()
            .take(position.saturating_sub(1) as usize)
            .map(|c| c.len_utf16() as u32)
            .sum();
        statement_start + before
    });
    StatementOutcome::Error {
        error: payload,
        offset,
    }
}

fn millis(since: Instant) -> u32 {
    u32::try_from(since.elapsed().as_millis()).unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_word_skips_comments_and_case() {
        assert_eq!(command_word("update t set x = 1"), "UPDATE");
        assert_eq!(
            command_word("  -- note\n  Insert INTO t VALUES (1)"),
            "INSERT"
        );
        assert_eq!(command_word("/* a */ /* b */ create table t ()"), "CREATE");
        assert_eq!(command_word("(select 1)"), "");
    }
}
