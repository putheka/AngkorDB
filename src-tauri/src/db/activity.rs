//! The process list and the locks: `pg_stat_activity` and `pg_blocking_pids` (ANG-41).

use tokio_postgres::Client;

use crate::error::{AppError, AppResult};
use crate::models::activity::{Backend, Signal};

/// How much of a query is sent: enough to read, not enough to flood the list.
const QUERY_CHARS: i32 = 4000;

const ACTIVITY_SQL: &str = "
SELECT a.pid,
       a.datname::text,
       a.usename::text,
       a.application_name::text,
       host(a.client_addr),
       a.state::text,
       a.wait_event_type::text,
       a.wait_event::text,
       EXTRACT(EPOCH FROM now() - CASE WHEN a.state = 'active' THEN a.query_start ELSE a.state_change END)::float8,
       EXTRACT(EPOCH FROM now() - a.xact_start)::float8,
       left(coalesce(a.query, ''), $1),
       pg_blocking_pids(a.pid),
       (SELECT l.mode || ' on ' || coalesce(l.relation::regclass::text, l.locktype)
          FROM pg_locks l WHERE l.pid = a.pid AND NOT l.granted LIMIT 1),
       a.pid = pg_backend_pid()
  FROM pg_stat_activity a
 WHERE a.backend_type = 'client backend'
 ORDER BY a.pid";

fn pid(value: i32) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

/// Every client connection of the server, with who blocks it. A role that is not a superuser
/// sees the details of its own connections only; the rest come back with empty fields.
pub async fn list(client: &Client) -> AppResult<Vec<Backend>> {
    let rows = client.query(ACTIVITY_SQL, &[&QUERY_CHARS]).await?;
    Ok(rows
        .iter()
        .map(|row| Backend {
            pid: pid(row.get(0)),
            database: row.get(1),
            user: row.get(2),
            application: row.get(3),
            client: row.get(4),
            state: row.get(5),
            wait_event_type: row.get(6),
            wait_event: row.get(7),
            state_secs: row.get(8),
            transaction_secs: row.get(9),
            query: row.get(10),
            blocked_by: row.get::<_, Vec<i32>>(11).into_iter().map(pid).collect(),
            lock_wait: row.get(12),
            is_self: row.get(13),
        })
        .collect())
}

/// Cancel the query of a backend, or close its connection. `false`: there was no such backend
/// any more (it finished first). A role that may not do this gets PostgreSQL's own error.
pub async fn signal(client: &Client, backend: u32, signal: Signal) -> AppResult<bool> {
    let target = i32::try_from(backend)
        .map_err(|_| AppError::Validation(format!("{backend} is not a process id.")))?;
    let own: i32 = client
        .query_one("SELECT pg_backend_pid()", &[])
        .await?
        .get(0);
    if own == target {
        return Err(AppError::Validation(
            "That is the connection this list is read with.".into(),
        ));
    }
    let sql = match signal {
        Signal::Cancel => "SELECT pg_cancel_backend($1)",
        Signal::Terminate => "SELECT pg_terminate_backend($1)",
    };
    Ok(client.query_one(sql, &[&target]).await?.get(0))
}
