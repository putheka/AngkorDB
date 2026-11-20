use serde::{Serialize, Serializer};
use tokio_postgres::error::ErrorPosition;

/// Every command returns `AppResult<T>`. The UI receives errors as
/// `{ code, message, pgCode?, detail?, hint?, position? }` (ANG-8 D9).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),

    /// The connection exists but no session is open for it.
    #[error("not connected to {0}")]
    NotConnected(String),

    /// A table, view or other database object that doesn't exist.
    #[error("{0} not found")]
    NotFound(String),

    #[error(transparent)]
    Postgres(#[from] tokio_postgres::Error),

    #[error("connection pool error: {0}")]
    Pool(String),

    #[error("timed out: {0}")]
    Timeout(String),

    #[error("TLS setup failed: {0}")]
    Tls(String),

    /// The user's input is invalid (empty host, bad URL, ...). The message is shown as-is.
    #[error("{0}")]
    Validation(String),

    #[error("could not read or write settings: {0}")]
    Storage(String),

    #[error("Keychain error: {0}")]
    Keychain(String),

    #[error("{0}")]
    Internal(String),

    /// The data is not what the edit expected (the row was changed or deleted meanwhile).
    #[error("{0}")]
    Conflict(String),

    /// The person decided not to go on (closed the Touch ID prompt, say). Not a failure.
    #[error("{0}")]
    Cancelled(String),

    /// Touch ID or the Mac password could not be checked.
    #[error("{0}")]
    Auth(String),

    /// One change of a batch failed, so the whole batch was rolled back (ANG-23).
    #[error("{what}: {source}")]
    Change {
        /// "Change 2 of 5 (update row id = 7)".
        what: String,
        source: Box<AppError>,
    },
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConnectionNotFound(_) => "CONNECTION_NOT_FOUND",
            Self::NotConnected(_) => "NOT_CONNECTED",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Postgres(e) if e.as_db_error().is_some() => "POSTGRES",
            Self::Postgres(_) => "CONNECTION",
            Self::Pool(_) => "POOL",
            Self::Timeout(_) => "TIMEOUT",
            Self::Tls(_) => "TLS",
            Self::Validation(_) => "VALIDATION",
            Self::Storage(_) => "STORAGE",
            Self::Keychain(_) => "KEYCHAIN",
            Self::Internal(_) => "INTERNAL",
            Self::Conflict(_) => "CONFLICT",
            Self::Cancelled(_) => "CANCELLED",
            Self::Auth(_) => "AUTH_FAILED",
            Self::Change { .. } => "CHANGE_FAILED",
        }
    }

    /// Human-readable message. For server errors this is Postgres' own message,
    /// without tokio-postgres' "db error: ERROR:" prefix. For connection errors the
    /// underlying cause is appended ("error connecting to server: Connection refused").
    pub fn message(&self) -> String {
        match self {
            Self::Postgres(e) => match (e.as_db_error(), std::error::Error::source(e)) {
                (Some(db), _) => db.message().to_owned(),
                (None, Some(cause)) => format!("{e}: {cause}"),
                (None, None) => e.to_string(),
            },
            Self::Change { what, source } => {
                format!("{what} failed: {} — nothing was saved.", source.message())
            }
            other => other.to_string(),
        }
    }

    /// True when the server could not be reached at all (refused, DNS, timeout).
    pub fn is_connection_error(&self) -> bool {
        matches!(self.code(), "CONNECTION" | "TIMEOUT")
    }

    /// SQLSTATE code, e.g. `23505` for a unique violation.
    pub fn pg_code(&self) -> Option<&str> {
        self.db_error().map(|db| db.code().code())
    }

    fn db_error(&self) -> Option<&tokio_postgres::error::DbError> {
        match self {
            Self::Postgres(e) => e.as_db_error(),
            Self::Change { source, .. } => source.db_error(),
            _ => None,
        }
    }
}

impl From<deadpool_postgres::PoolError> for AppError {
    fn from(err: deadpool_postgres::PoolError) -> Self {
        match err {
            deadpool_postgres::PoolError::Backend(e) => Self::Postgres(e),
            deadpool_postgres::PoolError::Timeout(_) => {
                Self::Timeout("waiting for a database connection".into())
            }
            other => Self::Pool(other.to_string()),
        }
    }
}

/// What the UI receives when a command fails (ANG-8 D9). Absent details are `null`.
#[derive(Debug, Serialize, specta::Type)]
#[serde(rename = "AppError", rename_all = "camelCase")]
pub struct AppErrorPayload {
    pub code: String,
    pub message: String,
    /// SQLSTATE, e.g. `23505`.
    pub pg_code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character offset into the submitted SQL.
    pub position: Option<u32>,
}

impl From<&AppError> for AppErrorPayload {
    fn from(err: &AppError) -> Self {
        let db = err.db_error();
        Self {
            code: err.code().to_owned(),
            message: err.message(),
            pg_code: db.map(|d| d.code().code().to_owned()),
            detail: db.and_then(|d| d.detail()).map(str::to_owned),
            hint: db.and_then(|d| d.hint()).map(str::to_owned),
            // A batch has no single SQL text the offset could point into.
            position: db
                .filter(|_| !matches!(err, AppError::Change { .. }))
                .and_then(|d| match d.position() {
                    Some(ErrorPosition::Original(p)) => Some(*p),
                    _ => None,
                }),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        AppErrorPayload::from(self).serialize(serializer)
    }
}

/// Commands return `AppResult<T>`; the error side is described by [`AppErrorPayload`].
impl specta::Type for AppError {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        AppErrorPayload::definition(types)
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_code_and_message() {
        let json = serde_json::to_string(&AppError::ConnectionNotFound("abc".into())).unwrap();
        assert_eq!(
            json,
            r#"{"code":"CONNECTION_NOT_FOUND","message":"connection not found: abc","pgCode":null,"detail":null,"hint":null,"position":null}"#
        );
    }
}
