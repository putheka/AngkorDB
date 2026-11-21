//! Read what `~/.ssh/config` says about a host name, to fill the SSH section of a connection
//! from it: `HostName`, `Port`, `User`, `IdentityFile` and the first hop of `ProxyJump`.
//!
//! Like `ssh`, the first value found for a setting wins, `Host` lines take patterns (`*`, `?`
//! and `!` to exclude), and `Host *` blocks apply to everything. Not supported: `Include`,
//! `Match`, tokens other than `%h` in `HostName`, and `ProxyCommand` (it is ignored, not run).

use std::path::Path;

use crate::models::connection::{SshAlias, SshAliasJump};

/// What `ssh_config` text says about `name`; `None` when no block names it (a `Host *` block
/// alone is not an alias).
pub fn lookup(config: &str, name: &str) -> Option<SshAlias> {
    let found = settings_for(config, name);
    if !found.named {
        return None;
    }
    let jump = found.proxy_jump.as_deref().and_then(first_hop).map(|hop| {
        let (user, host, port) = split_hop(hop);
        let inner = settings_for(config, host);
        SshAliasJump {
            host: inner.host_name.unwrap_or_else(|| host.to_owned()),
            port: port.or(inner.port).unwrap_or(22),
            user: user.map(str::to_owned).or(inner.user),
            identity_file: inner.identity_file,
        }
    });
    Some(SshAlias {
        host: found.host_name.unwrap_or_else(|| name.to_owned()),
        port: found.port.unwrap_or(22),
        user: found.user,
        identity_file: found.identity_file,
        jump,
    })
}

/// [`lookup`] in the person's own `~/.ssh/config` (a missing or unreadable file knows nothing).
pub fn lookup_in_home(name: &str) -> Option<SshAlias> {
    let path = std::env::home_dir()?.join(".ssh").join("config");
    lookup_in_file(&path, name)
}

pub fn lookup_in_file(path: &Path, name: &str) -> Option<SshAlias> {
    let text = std::fs::read_to_string(path).ok()?;
    lookup(&text, name)
}

#[derive(Default)]
struct Found {
    /// A `Host` block other than `*` matched the name.
    named: bool,
    host_name: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    identity_file: Option<String>,
    proxy_jump: Option<String>,
}

fn settings_for(config: &str, name: &str) -> Found {
    let mut found = Found::default();
    let mut active = false;
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = split_setting(line) else {
            continue;
        };
        if key.eq_ignore_ascii_case("host") {
            let patterns: Vec<&str> = value.split_whitespace().collect();
            active = matches_patterns(&patterns, name);
            if active && patterns.iter().any(|p| *p != "*" && !p.starts_with('!')) {
                found.named = true;
            }
            continue;
        }
        if key.eq_ignore_ascii_case("match") {
            // Not supported: what follows applies to nothing.
            active = false;
            continue;
        }
        if !active {
            continue;
        }
        let value = unquote(value);
        match key.to_ascii_lowercase().as_str() {
            // `%h` is the name that was typed.
            "hostname" => {
                found.host_name = found.host_name.or(Some(value.replace("%h", name)));
            }
            "port" => found.port = found.port.or(value.parse().ok()),
            "user" => found.user = found.user.or(Some(value.to_owned())),
            "identityfile" => found.identity_file = found.identity_file.or(Some(value.to_owned())),
            "proxyjump" => found.proxy_jump = found.proxy_jump.or(Some(value.to_owned())),
            _ => {}
        }
    }
    found
}

/// `Key value` or `Key=value`.
fn split_setting(line: &str) -> Option<(&str, &str)> {
    let at = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (key, rest) = line.split_at(at);
    let value = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    (!value.is_empty()).then_some((key, value.trim()))
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .unwrap_or(value)
}

/// A name matches when one pattern matches and none of the `!` ones does.
fn matches_patterns(patterns: &[&str], name: &str) -> bool {
    let mut matched = false;
    for pattern in patterns {
        match pattern.strip_prefix('!') {
            Some(negated) if glob(negated, name) => return false,
            Some(_) => {}
            None if glob(pattern, name) => matched = true,
            None => {}
        }
    }
    matched
}

/// `*` and `?` wildcards, case-insensitive like host names.
fn glob(pattern: &str, text: &str) -> bool {
    fn go(p: &[char], t: &[char]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some(('*', rest)) => (0..=t.len()).any(|skip| go(rest, &t[skip..])),
            Some(('?', rest)) => !t.is_empty() && go(rest, &t[1..]),
            Some((c, rest)) => t.first().is_some_and(|x| x == c) && go(rest, &t[1..]),
        }
    }
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    go(&p, &t)
}

/// `ProxyJump a,b,c`: the one `ssh` connects to first is the first. `none` is no jump.
fn first_hop(value: &str) -> Option<&str> {
    let hop = value.split(',').next()?.trim();
    (!hop.is_empty() && !hop.eq_ignore_ascii_case("none")).then_some(hop)
}

/// `[user@]host[:port]` (also `ssh://user@host:port`).
fn split_hop(hop: &str) -> (Option<&str>, &str, Option<u16>) {
    let hop = hop.strip_prefix("ssh://").unwrap_or(hop);
    let (user, rest) = match hop.split_once('@') {
        Some((user, rest)) => (Some(user), rest),
        None => (None, hop),
    };
    // `[::1]:22` keeps its brackets' content.
    if let Some(inner) = rest.strip_prefix('[')
        && let Some((host, tail)) = inner.split_once(']')
    {
        return (
            user,
            host,
            tail.strip_prefix(':').and_then(|p| p.parse().ok()),
        );
    }
    match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => match port.parse() {
            Ok(port) => (user, host, Some(port)),
            Err(_) => (user, rest, None),
        },
        _ => (user, rest, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"
# work
Host bastion
    HostName bastion.example.com
    User deploy
    Port 2200
    IdentityFile ~/.ssh/work_ed25519

Host db-* !db-old
    HostName=%h.internal.example.com
    ProxyJump bastion
    User admin

Host staging
  HostName 10.0.0.5
  ProxyJump ops@jump.example.com:2222,other

Host *
    User fallback
    Port 22
    IdentityFile ~/.ssh/id_rsa
"#;

    #[test]
    fn a_named_block_gives_its_settings_and_the_wildcard_block_fills_the_rest() {
        let bastion = lookup(CONFIG, "bastion").unwrap();
        assert_eq!(bastion.host, "bastion.example.com");
        assert_eq!(bastion.port, 2200);
        // The first value wins: the named block's, not `Host *`'s.
        assert_eq!(bastion.user.as_deref(), Some("deploy"));
        assert_eq!(
            bastion.identity_file.as_deref(),
            Some("~/.ssh/work_ed25519")
        );
        assert_eq!(bastion.jump, None);
    }

    #[test]
    fn a_name_nothing_mentions_is_not_an_alias() {
        assert_eq!(lookup(CONFIG, "example.org"), None);
        assert_eq!(lookup("", "bastion"), None);
        assert_eq!(lookup("Host *\n  User x\n", "anything"), None);
    }

    #[test]
    fn patterns_match_and_exclusions_win() {
        assert!(lookup(CONFIG, "db-prod").is_some());
        assert!(lookup(CONFIG, "DB-Prod").is_some());
        assert_eq!(lookup(CONFIG, "db-old"), None);
        assert_eq!(
            lookup(CONFIG, "db-prod").unwrap().user.as_deref(),
            Some("admin")
        );
    }

    #[test]
    fn proxy_jump_is_resolved_through_the_file() {
        let prod = lookup(CONFIG, "db-prod").unwrap();
        assert_eq!(prod.host, "db-prod.internal.example.com");
        let jump = prod.jump.unwrap();
        assert_eq!(jump.host, "bastion.example.com");
        assert_eq!(jump.port, 2200);
        assert_eq!(jump.user.as_deref(), Some("deploy"));
        assert_eq!(jump.identity_file.as_deref(), Some("~/.ssh/work_ed25519"));
    }

    #[test]
    fn a_proxy_jump_hop_spelled_out_wins_over_the_file_and_only_the_first_hop_counts() {
        let staging = lookup(CONFIG, "staging").unwrap();
        assert_eq!(staging.host, "10.0.0.5");
        assert_eq!(staging.user.as_deref(), Some("fallback"));
        let jump = staging.jump.unwrap();
        assert_eq!(jump.host, "jump.example.com");
        assert_eq!(jump.port, 2222);
        assert_eq!(jump.user.as_deref(), Some("ops"));
        // Nothing in the file about it: the id file of `Host *` still applies, as ssh would.
        assert_eq!(jump.identity_file.as_deref(), Some("~/.ssh/id_rsa"));
    }

    #[test]
    fn none_is_no_jump_and_odd_lines_are_skipped() {
        let text = "Host a\n  ProxyJump none\n  Port abc\n  HostName a.example\n\nbroken\nHost b\n  Match all\n  User nope\n";
        let a = lookup(text, "a").unwrap();
        assert_eq!(a.jump, None);
        assert_eq!(a.port, 22);
        assert_eq!(a.host, "a.example");
        let b = lookup(text, "b").unwrap();
        assert_eq!(b.user, None);
    }

    #[test]
    fn hops_are_split_into_user_host_and_port() {
        assert_eq!(split_hop("host"), (None, "host", None));
        assert_eq!(split_hop("u@host:2200"), (Some("u"), "host", Some(2200)));
        assert_eq!(split_hop("ssh://u@host:22"), (Some("u"), "host", Some(22)));
        assert_eq!(split_hop("[::1]:2200"), (None, "::1", Some(2200)));
        assert_eq!(split_hop("host:notaport"), (None, "host:notaport", None));
    }

    #[test]
    fn a_file_is_read_from_disk_and_a_missing_one_knows_nothing() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("config");
        assert_eq!(lookup_in_file(&path, "bastion"), None);
        std::fs::write(&path, CONFIG).unwrap();
        assert_eq!(lookup_in_file(&path, "bastion").unwrap().port, 2200);
    }
}
