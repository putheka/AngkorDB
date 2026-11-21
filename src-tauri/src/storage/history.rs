//! Query history and saved queries in a local SQLite file (ANG-33).
//!
//! `history` keeps the last [`MAX_HISTORY`] statements that were run; `saved_queries` keeps what
//! the person saved. Passwords in `CREATE/ALTER ROLE … PASSWORD` statements are never stored.

use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params, params_from_iter};

use crate::error::{AppError, AppResult};
use crate::models::history::{HistoryEntry, SavedQuery, SavedQueryInput};

/// Older entries are deleted as new ones arrive.
pub const MAX_HISTORY: u32 = 10_000;

/// What is stored instead of a statement that contains a password.
pub const HIDDEN: &str = "-- statement not kept: it contains a password";

fn storage(error: rusqlite::Error) -> AppError {
    AppError::Storage(format!("query history: {error}"))
}

pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `sql` with `--` and (nested) `/* */` comments taken out. Strings are not looked at: this is
/// only for spotting secrets, where cutting too much is harmless.
fn without_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let (mut i, mut depth) = (0, 0usize);
    while i < bytes.len() {
        if bytes[i..].starts_with(b"/*") {
            depth += 1;
            i += 2;
        } else if depth > 0 && bytes[i..].starts_with(b"*/") {
            depth -= 1;
            i += 2;
        } else if depth == 0 && bytes[i..].starts_with(b"--") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            if depth == 0 {
                let ch = sql[i..].chars().next().unwrap_or(' ');
                out.push(ch);
                i += ch.len_utf8();
            } else {
                i += 1;
            }
        }
    }
    out
}

/// Does `lower` (lower-case SQL) give a password a value: `PASSWORD 'x'`, `password = 'x'`,
/// `host=h password=x`, `PASSWORD $$x$$`? A column called `password` that is only selected, or
/// the string `'password'`, does not.
fn sets_a_password(lower: &str) -> bool {
    for word in ["password", "passwd"] {
        for (at, _) in lower.match_indices(word) {
            let before = lower[..at].chars().next_back();
            let after = &lower[at + word.len()..];
            if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                continue;
            }
            if after.starts_with(|c: char| c.is_alphanumeric() || c == '_') {
                continue;
            }
            // The string 'password' (or a name in quotes like "password" that is not given a value).
            if before == Some('\'') && after.starts_with('\'') {
                continue;
            }
            let rest = after.strip_prefix('"').unwrap_or(after).trim_start();
            if rest.starts_with(['=', '\'', '$']) || rest.starts_with("e'") {
                return true;
            }
        }
    }
    false
}

/// The statement as it may be stored: one that gives a password a value (`CREATE ROLE … PASSWORD`,
/// `CREATE USER MAPPING … OPTIONS (password '…')`, a `CONNECTION 'host=… password=…'` string,
/// `dblink_connect('… password=…')`, inside a `DO` block, …) is replaced. The text is checked as
/// written and with its comments taken out, so a comment can't hide the keyword from the check.
pub fn redact(sql: &str) -> &str {
    let lower = sql.to_ascii_lowercase();
    if sets_a_password(&lower) || sets_a_password(&without_comments(&lower)) {
        HIDDEN
    } else {
        sql
    }
}

pub struct HistoryStore {
    db: Mutex<Connection>,
}

impl HistoryStore {
    pub fn open(path: &Path) -> AppResult<Self> {
        Self::init(Connection::open(path).map_err(storage)?)
    }

    /// For tests, and the fallback when the file can't be opened.
    pub fn in_memory() -> AppResult<Self> {
        Self::init(Connection::open_in_memory().map_err(storage)?)
    }

    fn init(db: Connection) -> AppResult<Self> {
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS history (
               id INTEGER PRIMARY KEY,
               conn_id TEXT NOT NULL,
               sql TEXT NOT NULL,
               ran_at INTEGER NOT NULL,
               duration_ms INTEGER NOT NULL,
               ok INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS history_by_connection ON history (conn_id, id DESC);
             CREATE TABLE IF NOT EXISTS saved_queries (
               id INTEGER PRIMARY KEY,
               conn_id TEXT,
               name TEXT NOT NULL,
               folder TEXT NOT NULL DEFAULT '',
               sql TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );",
        )
        .map_err(storage)?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| AppError::Internal("the history database lock is poisoned".into()))
    }

    /// Remember a statement that ran. Running the same statement again right after only updates
    /// the last entry, so a query re-run twenty times is one line, not twenty.
    pub fn add(
        &self,
        connection_id: &str,
        sql: &str,
        ran_at: f64,
        duration_ms: u32,
        ok: bool,
    ) -> AppResult<()> {
        let sql = redact(sql.trim());
        if sql.is_empty() {
            return Ok(());
        }
        let mut db = self.lock()?;
        let tx = db.transaction().map_err(storage)?;
        let last: Option<(i64, String)> = tx
            .query_row(
                "SELECT id, sql FROM history WHERE conn_id = ?1 ORDER BY id DESC LIMIT 1",
                [connection_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        match last {
            Some((id, previous)) if previous == sql => {
                tx.execute(
                    "UPDATE history SET ran_at = ?1, duration_ms = ?2, ok = ?3 WHERE id = ?4",
                    params![ran_at as i64, duration_ms, ok, id],
                )
                .map_err(storage)?;
            }
            _ => {
                tx.execute(
                    "INSERT INTO history (conn_id, sql, ran_at, duration_ms, ok)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![connection_id, sql, ran_at as i64, duration_ms, ok],
                )
                .map_err(storage)?;
                tx.execute(
                    "DELETE FROM history WHERE id <=
                       (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET ?1)",
                    [MAX_HISTORY],
                )
                .map_err(storage)?;
            }
        }
        tx.commit().map_err(storage)
    }

    /// Newest first. Every word of `query` must appear in the statement (any case).
    pub fn search(
        &self,
        query: &str,
        connection_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> AppResult<Vec<HistoryEntry>> {
        let mut clauses: Vec<String> = Vec::new();
        let mut values: Vec<String> = Vec::new();
        if let Some(id) = connection_id {
            clauses.push("conn_id = ?".into());
            values.push(id.to_owned());
        }
        for word in query.split_whitespace().take(8) {
            clauses.push("sql LIKE ? ESCAPE '\\'".into());
            let escaped = word
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            values.push(format!("%{escaped}%"));
        }
        let filter = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let sql = format!(
            "SELECT id, conn_id, sql, ran_at, duration_ms, ok FROM history {filter}
              ORDER BY id DESC LIMIT {} OFFSET {}",
            limit.clamp(1, 1000),
            offset
        );
        let db = self.lock()?;
        let mut statement = db.prepare(&sql).map_err(storage)?;
        let rows = statement
            .query_map(params_from_iter(values), |row| {
                Ok(HistoryEntry {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    sql: row.get(2)?,
                    ran_at: row.get::<_, i64>(3)? as f64,
                    duration_ms: row.get(4)?,
                    ok: row.get(5)?,
                })
            })
            .map_err(storage)?;
        rows.collect::<Result<_, _>>().map_err(storage)
    }

    pub fn delete(&self, id: u32) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM history WHERE id = ?1", [id])
            .map_err(storage)?;
        Ok(())
    }

    /// Forget one connection's history, or everything.
    pub fn clear(&self, connection_id: Option<&str>) -> AppResult<()> {
        let db = self.lock()?;
        match connection_id {
            Some(id) => db.execute("DELETE FROM history WHERE conn_id = ?1", [id]),
            None => db.execute("DELETE FROM history", []),
        }
        .map_err(storage)?;
        Ok(())
    }

    /// Saved queries for a connection (and those for every connection), by folder then name.
    pub fn saved(&self, connection_id: Option<&str>) -> AppResult<Vec<SavedQuery>> {
        let db = self.lock()?;
        let mut statement = db
            .prepare(
                "SELECT id, conn_id, name, folder, sql, created_at FROM saved_queries
                  WHERE conn_id IS NULL OR conn_id = ?1 OR ?1 IS NULL
                  ORDER BY folder COLLATE NOCASE, name COLLATE NOCASE, id",
            )
            .map_err(storage)?;
        let rows = statement
            .query_map([connection_id], |row| {
                Ok(SavedQuery {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    name: row.get(2)?,
                    folder: row.get(3)?,
                    sql: row.get(4)?,
                    created_at: row.get::<_, i64>(5)? as f64,
                })
            })
            .map_err(storage)?;
        rows.collect::<Result<_, _>>().map_err(storage)
    }

    /// Save a new query, or change one that exists (name, folder, text).
    pub fn save(&self, input: &SavedQueryInput) -> AppResult<SavedQuery> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(AppError::Validation("Give the query a name.".into()));
        }
        if input.sql.trim().is_empty() {
            return Err(AppError::Validation("There is no SQL to save.".into()));
        }
        let folder = input.folder.trim();
        let db = self.lock()?;
        let id = match input.id {
            Some(id) => {
                let changed = db
                    .execute(
                        "UPDATE saved_queries SET name = ?1, folder = ?2, sql = ?3, conn_id = ?4
                          WHERE id = ?5",
                        params![name, folder, input.sql, input.connection_id, id],
                    )
                    .map_err(storage)?;
                if changed == 0 {
                    return Err(AppError::NotFound(format!("saved query {id}")));
                }
                i64::from(id)
            }
            None => {
                db.execute(
                    "INSERT INTO saved_queries (conn_id, name, folder, sql, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        input.connection_id,
                        name,
                        folder,
                        input.sql,
                        now_ms() as i64
                    ],
                )
                .map_err(storage)?;
                db.last_insert_rowid()
            }
        };
        db.query_row(
            "SELECT id, conn_id, name, folder, sql, created_at FROM saved_queries WHERE id = ?1",
            [id],
            |row| {
                Ok(SavedQuery {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    name: row.get(2)?,
                    folder: row.get(3)?,
                    sql: row.get(4)?,
                    created_at: row.get::<_, i64>(5)? as f64,
                })
            },
        )
        .map_err(storage)
    }

    pub fn delete_saved(&self, id: u32) -> AppResult<()> {
        self.lock()?
            .execute("DELETE FROM saved_queries WHERE id = ?1", [id])
            .map_err(storage)?;
        Ok(())
    }
}
