use serde::{Serialize, Serializer};
use tokio_postgres::error::ErrorPosition;

/// Every command returns `AppResult<T>`. The UI receives errors as
/// `{ code, message, pgCode?, detail?, hint?, position? }` (ANG-8 D9).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),

    #[error(transparent)]
    Postgres(#[from] tokio_postgres::Error),

    #[error("connection pool error: {0}")]
    Pool(String),

    #[error("timed out: {0}")]
    Timeout(String),

    #[error("TLS setup failed: {0}")]
    Tls(String),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConnectionNotFound(_) => "CONNECTION_NOT_FOUND",
            Self::Postgres(e) if e.as_db_error().is_some() => "POSTGRES",
            Self::Postgres(_) => "CONNECTION",
            Self::Pool(_) => "POOL",
            Self::Timeout(_) => "TIMEOUT",
            Self::Tls(_) => "TLS",
            Self::Internal(_) => "INTERNAL",
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload<'a> {
    code: &'a str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pg_code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    hint: Option<&'a str>,
    /// 1-based character offset into the submitted SQL.
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<u32>,
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let db = self.db_error();
        ErrorPayload {
            code: self.code(),
            message: self.message(),
            pg_code: db.map(|d| d.code().code()),
            detail: db.and_then(|d| d.detail()),
            hint: db.and_then(|d| d.hint()),
            position: db.and_then(|d| match d.position() {
                Some(ErrorPosition::Original(p)) => Some(*p),
                _ => None,
            }),
        }
        .serialize(serializer)
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
            r#"{"code":"CONNECTION_NOT_FOUND","message":"connection not found: abc"}"#
        );
    }
}
