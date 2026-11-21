//! `EXPLAIN` and `EXPLAIN ANALYZE` for one statement of a query tab (ANG-35).
//!
//! A plain `EXPLAIN` only plans the statement. `ANALYZE` *runs* it, so it always happens inside a
//! transaction that is rolled back afterwards. If the tab already has a transaction open (the
//! person typed `BEGIN`), a savepoint is used instead, so their transaction is never ended.

use std::time::Instant;

use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, SimpleQueryMessage};

use crate::db::classify::{self, Kind};
use crate::db::query;
use crate::db::script;
use crate::db::session::Session;
use crate::error::{AppError, AppErrorPayload, AppResult};
use crate::models::connection::SafeMode;
use crate::models::explain::{ExplainOutcome, ExplainRun};
use crate::models::query::StatementKind;

const SAVEPOINT: &str = "angkordb_explain";

/// How an analyzed statement is kept from changing anything.
enum Guard {
    /// `BEGIN` … `ROLLBACK`.
    Transaction,
    /// The tab is inside a transaction already: `SAVEPOINT` … `ROLLBACK TO`.
    Savepoint,
}

async fn begin(client: &Client) -> AppResult<Guard> {
    match client
        .batch_execute(&format!("SAVEPOINT {SAVEPOINT}"))
        .await
    {
        Ok(()) => Ok(Guard::Savepoint),
        // Not in a transaction: a savepoint can't be made, so open one of our own.
        Err(e) if e.code() == Some(&SqlState::NO_ACTIVE_SQL_TRANSACTION) => {
            client.batch_execute("BEGIN").await?;
            Ok(Guard::Transaction)
        }
        // Includes "current transaction is aborted": nothing runs until the person rolls back.
        Err(e) => Err(e.into()),
    }
}

async fn end(client: &Client, guard: &Guard) {
    let sql = match guard {
        Guard::Transaction => "ROLLBACK".to_owned(),
        Guard::Savepoint => {
            format!("ROLLBACK TO SAVEPOINT {SAVEPOINT}; RELEASE SAVEPOINT {SAVEPOINT}")
        }
    };
    // If this fails the connection is gone, and with it the transaction.
    let _ = client.batch_execute(&sql).await;
}

fn statement_kind(kind: Kind) -> StatementKind {
    match kind {
        Kind::Read => StatementKind::Read,
        Kind::Write => StatementKind::Write,
        Kind::Schema => StatementKind::Schema,
    }
}

/// Explain the one statement in `sql`. Errors from the server come back inside the result (with
/// a position into `sql`); `Err` is for things that stopped it before: no connection, not exactly
/// one statement, a statement `EXPLAIN` doesn't take.
pub async fn explain(
    session: &Session,
    tab_id: &str,
    sql: &str,
    analyze: bool,
) -> AppResult<ExplainRun> {
    let statements = script::split(sql);
    let statement = match statements.as_slice() {
        [] => {
            return Err(AppError::Validation(
                "There is no SQL to explain: the editor is empty or only has comments.".into(),
            ));
        }
        [one] => one,
        _ => {
            return Err(AppError::Validation(
                "Explain works on one statement at a time. Put the cursor in the statement, or select it."
                    .into(),
            ));
        }
    };
    let text = &sql[statement.start..statement.end];
    let class = classify::classify(text);
    if query::command_word(text) == "EXPLAIN" {
        return Err(AppError::Validation(
            "This statement already starts with EXPLAIN. Remove it: the Explain buttons add it."
                .into(),
        ));
    }
    if analyze && session.config().safe_mode == SafeMode::ReadOnly && class.unlocks_writes {
        return Err(AppError::Validation(
            "This connection is read-only, so a statement that could make the session writable is \
             not run. Change the connection's safe mode to write."
                .into(),
        ));
    }

    let client = session.tab_client(tab_id).await?;
    let options = if analyze {
        "ANALYZE, BUFFERS, FORMAT JSON"
    } else {
        "FORMAT JSON"
    };
    let prefix = format!("EXPLAIN ({options}) ");
    let started = Instant::now();

    let guard = if analyze {
        Some(begin(&client).await?)
    } else {
        None
    };
    let result = client.simple_query(&format!("{prefix}{text}")).await;
    if let Some(guard) = &guard {
        end(&client, guard).await;
    }
    let duration_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);

    let outcome = match result {
        Ok(messages) => match first_value(&messages) {
            Some(json) => ExplainOutcome::Plan { json },
            None => {
                return Err(AppError::Internal("EXPLAIN returned no plan.".into()));
            }
        },
        Err(error) => error_outcome(
            &AppError::from(error),
            text,
            statement.utf16_start,
            prefix.chars().count(),
        ),
    };
    Ok(ExplainRun {
        outcome,
        duration_ms,
        analyzed: analyze,
        statement_kind: statement_kind(class.kind),
        command: class.command,
        rolled_back: analyze,
    })
}

/// The first column of the first row.
fn first_value(messages: &[SimpleQueryMessage]) -> Option<String> {
    messages.iter().find_map(|message| match message {
        SimpleQueryMessage::Row(row) => row.get(0).map(str::to_owned),
        _ => None,
    })
}

/// The server's error with its position moved from the `EXPLAIN (…) …` text we sent to the
/// statement the person wrote, and then into `sql` as a UTF-16 offset.
fn error_outcome(
    error: &AppError,
    statement_text: &str,
    statement_start: u32,
    prefix_chars: usize,
) -> ExplainOutcome {
    let mut payload = AppErrorPayload::from(error);
    // 1-based in characters of what was sent; a position inside our own prefix means nothing.
    payload.position = payload
        .position
        .and_then(|p| usize::try_from(p).ok())
        .and_then(|p| p.checked_sub(prefix_chars))
        .filter(|p| *p >= 1)
        .and_then(|p| u32::try_from(p).ok());
    let offset = payload.position.map(|position| {
        let before: u32 = statement_text
            .chars()
            .take(position.saturating_sub(1) as usize)
            .map(|c| c.len_utf16() as u32)
            .sum();
        statement_start + before
    });
    ExplainOutcome::Error {
        error: payload,
        offset,
    }
}
