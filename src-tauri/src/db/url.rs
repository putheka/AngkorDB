//! Parse `postgres://user:password@host:port/database?sslmode=...` into form fields.

use percent_encoding::percent_decode_str;
use url::{Host, Url};

use crate::error::{AppError, AppResult};
use crate::models::connection::{ParsedConnectionUrl, SslMode};

const DEFAULT_PORT: u16 = 5432;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

fn decode(raw: &str, what: &str) -> AppResult<String> {
    percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|_| invalid(format!("The {what} in the URL is not valid UTF-8")))
}

fn parse_ssl_mode(value: &str) -> AppResult<SslMode> {
    match value {
        "disable" => Ok(SslMode::Disable),
        // libpq's `allow` tries plain first; `prefer` is the closest mode we offer.
        "allow" | "prefer" => Ok(SslMode::Prefer),
        "require" => Ok(SslMode::Require),
        "verify-ca" => Ok(SslMode::VerifyCa),
        "verify-full" => Ok(SslMode::VerifyFull),
        other => Err(invalid(format!(
            "Unsupported sslmode '{other}' (use disable, prefer, require, verify-ca or verify-full)"
        ))),
    }
}

pub fn parse_connection_url(input: &str) -> AppResult<ParsedConnectionUrl> {
    let url = Url::parse(input.trim())
        .map_err(|e| invalid(format!("This is not a valid connection URL ({e})")))?;

    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(invalid(
            "The URL must start with postgres:// or postgresql://",
        ));
    }

    let host = match url.host() {
        Some(Host::Domain(domain)) => domain.to_owned(),
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        None => return Err(invalid("The URL has no host")),
    };
    if host.is_empty() {
        return Err(invalid("The URL has no host"));
    }

    let user = decode(url.username(), "user name")?;
    let password = match url.password() {
        Some(raw) => Some(decode(raw, "password")?).filter(|p| !p.is_empty()),
        None => None,
    };

    // Like libpq, the database defaults to the user name.
    let database = match decode(url.path().trim_start_matches('/'), "database name")? {
        db if db.is_empty() => user.clone(),
        db => db,
    };

    let mut ssl_mode = SslMode::default();
    for (key, value) in url.query_pairs() {
        if key == "sslmode" {
            ssl_mode = parse_ssl_mode(&value)?;
        }
    }

    let name = if database.is_empty() {
        host.clone()
    } else {
        format!("{database} @ {host}")
    };

    Ok(ParsedConnectionUrl {
        name,
        host,
        port: url.port().unwrap_or(DEFAULT_PORT),
        user,
        password,
        database,
        ssl_mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_url() {
        let p = parse_connection_url(
            "postgres://alice:s3cret@db.example.com:6543/shop?sslmode=verify-full",
        )
        .unwrap();
        assert_eq!(p.host, "db.example.com");
        assert_eq!(p.port, 6543);
        assert_eq!(p.user, "alice");
        assert_eq!(p.password.as_deref(), Some("s3cret"));
        assert_eq!(p.database, "shop");
        assert_eq!(p.ssl_mode, SslMode::VerifyFull);
        assert_eq!(p.name, "shop @ db.example.com");
    }

    #[test]
    fn accepts_the_postgresql_scheme_and_defaults() {
        let p = parse_connection_url("postgresql://bob@localhost").unwrap();
        assert_eq!(p.port, 5432);
        assert_eq!(p.password, None);
        assert_eq!(p.database, "bob", "database defaults to the user");
        assert_eq!(p.ssl_mode, SslMode::Prefer);
    }

    #[test]
    fn decodes_percent_encoded_credentials() {
        let p = parse_connection_url("postgres://us%40er:p%40ss%3Aw%2Ford%23@h/d%20b").unwrap();
        assert_eq!(p.user, "us@er");
        assert_eq!(p.password.as_deref(), Some("p@ss:w/ord#"));
        assert_eq!(p.database, "d b");
    }

    #[test]
    fn handles_ipv6_hosts() {
        let p = parse_connection_url("postgres://u:p@[::1]:5433/db").unwrap();
        assert_eq!(p.host, "::1");
        assert_eq!(p.port, 5433);
    }

    #[test]
    fn maps_every_sslmode() {
        let mode = |m: &str| {
            parse_connection_url(&format!("postgres://u@h/d?sslmode={m}"))
                .unwrap()
                .ssl_mode
        };
        assert_eq!(mode("disable"), SslMode::Disable);
        assert_eq!(mode("allow"), SslMode::Prefer);
        assert_eq!(mode("prefer"), SslMode::Prefer);
        assert_eq!(mode("require"), SslMode::Require);
        assert_eq!(mode("verify-ca"), SslMode::VerifyCa);
        assert_eq!(mode("verify-full"), SslMode::VerifyFull);
    }

    #[test]
    fn ignores_unrelated_query_parameters() {
        let p =
            parse_connection_url("postgres://u@h/d?application_name=x&connect_timeout=3").unwrap();
        assert_eq!(p.ssl_mode, SslMode::Prefer);
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert!(parse_connection_url("  postgres://u@h/d \n").is_ok());
    }

    #[test]
    fn empty_password_counts_as_none() {
        let p = parse_connection_url("postgres://u:@h/d").unwrap();
        assert_eq!(p.password, None);
    }

    #[test]
    fn rejects_bad_input_with_a_readable_message() {
        for (input, expected) in [
            ("mysql://u@h/d", "must start with postgres"),
            ("not a url", "not a valid connection URL"),
            ("postgres:///db", "no host"),
            (
                "postgres://u@h/d?sslmode=banana",
                "Unsupported sslmode 'banana'",
            ),
        ] {
            let err = parse_connection_url(input).unwrap_err();
            assert_eq!(err.code(), "VALIDATION", "{input}");
            assert!(
                err.message().contains(expected),
                "{input}: {}",
                err.message()
            );
        }
    }

    #[test]
    fn debug_output_hides_the_password() {
        let p = parse_connection_url("postgres://u:topsecret@h/d").unwrap();
        assert!(!format!("{p:?}").contains("topsecret"));
    }
}
