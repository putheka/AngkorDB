use serde::{Serialize, Serializer};

/// Every command returns `AppResult<T>`; the UI receives errors as `{ code, message }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConnectionNotFound(_) => "CONNECTION_NOT_FOUND",
            Self::Internal(_) => "INTERNAL",
        }
    }
}

#[derive(Serialize)]
struct ErrorPayload<'a> {
    code: &'a str,
    message: String,
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
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
