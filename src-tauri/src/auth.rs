//! Ask the person at the keyboard to prove it: Touch ID, or the Mac password when there is no
//! sensor or it is not set up (ANG-25, the Touch ID safe mode).
//!
//! macOS shows the system sheet (`LocalAuthentication`); the app never sees a fingerprint or a
//! password. Other platforms have no such thing and refuse, so the Touch ID mode can't be
//! satisfied there by accident.

use crate::error::{AppError, AppResult};

/// Show the system prompt with `reason` ("save changes to Production") and wait for the answer.
/// Cancelling is [`AppError::Cancelled`], any other failure [`AppError::Auth`].
#[cfg(target_os = "macos")]
pub async fn authenticate(reason: &str) -> AppResult<()> {
    use std::sync::Mutex;

    use robius_authentication::{
        AndroidText, BiometricStrength, Context, Error, PolicyBuilder, Text, WindowsText,
    };
    use tokio::sync::oneshot;

    // An empty reason aborts the process inside the framework.
    let reason = match reason.trim() {
        "" => "confirm this change",
        trimmed => trimmed,
    };
    let policy = PolicyBuilder::new()
        // Touch ID, falling back to the account password.
        .biometrics(Some(BiometricStrength::Strong))
        .password(true)
        .build()
        .ok_or_else(|| AppError::Auth("This Mac can't check Touch ID or a password".into()))?;
    let windows = WindowsText::new("AngkorDB", reason)
        .ok_or_else(|| AppError::Auth("The prompt text is too long".into()))?;
    let text = Text {
        android: AndroidText {
            title: reason,
            subtitle: None,
            description: None,
        },
        apple: reason,
        windows,
    };

    // The answer arrives later, on a thread of the framework.
    let (answer, waiting) = oneshot::channel::<Result<(), Error>>();
    let answer = Mutex::new(Some(answer));
    Context::new(())
        .authenticate(text, &policy, move |result| {
            if let Ok(mut slot) = answer.lock()
                && let Some(sender) = slot.take()
            {
                let _ = sender.send(result);
            }
        })
        .map_err(describe)?;

    waiting
        .await
        .map_err(|_| AppError::Auth("The prompt was dismissed without an answer".into()))?
        .map_err(describe)
}

#[cfg(target_os = "macos")]
fn describe(error: robius_authentication::Error) -> AppError {
    use robius_authentication::Error;
    match error {
        Error::UserCanceled | Error::AppCanceled | Error::SystemCanceled => {
            AppError::Cancelled("Authentication cancelled".into())
        }
        Error::Authentication => AppError::Auth("Authentication failed".into()),
        Error::Exhausted => AppError::Auth("Too many failed attempts; try again later".into()),
        Error::PasscodeNotSet => {
            AppError::Auth("Set a password for this Mac to use Touch ID mode".into())
        }
        Error::NotEnrolled | Error::Unavailable => {
            AppError::Auth("Touch ID and the Mac password are not available".into())
        }
        other => AppError::Auth(format!("Authentication failed: {other:?}")),
    }
}

#[cfg(not(target_os = "macos"))]
pub async fn authenticate(_reason: &str) -> AppResult<()> {
    Err(AppError::Auth("Touch ID is only available on macOS".into()))
}

#[cfg(test)]
mod tests {
    /// Opens the real system prompt, so it needs a person: `cargo test touch_id -- --ignored`.
    /// Cancel it to see `CANCELLED`; approve it to see `Ok`.
    #[tokio::test]
    #[ignore = "shows the Touch ID prompt and waits for you"]
    async fn touch_id_prompt() {
        let result = super::authenticate("test AngkorDB's Touch ID mode").await;
        eprintln!("touch id result: {result:?}");
        assert!(
            result.is_ok() || matches!(result, Err(crate::error::AppError::Cancelled(_))),
            "{result:?}"
        );
    }
}
