//! Tell what a SQL statement does, without a connection (ANG-25).
//!
//! Used for two things:
//!
//! - **Confirm / Touch ID** safe modes ask before running a statement that changes data or
//!   schema: [`classify`] says which statements those are.
//! - **Read-only** connections already make the *server* refuse writes
//!   (`default_transaction_read_only`), but the SQL tab could switch that off again. A statement
//!   that [`Classified::unlocks_writes`] is refused before it is sent.
//!
//! This is a guard against accidents, not a security boundary: it reads the first words of the
//! statement and cannot see what a function you call does. The real protection of a read-only
//! connection is the server setting (or, for certainty, a database role without write grants).

/// What a statement does to the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Reads, or only changes the session (`SELECT`, `SHOW`, `BEGIN`, `SET`, …).
    Read,
    /// Changes data: `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `SELECT … INTO`, `COPY … FROM`,
    /// `CALL`, `DO`, …
    Write,
    /// Changes the schema or permissions: `CREATE`, `ALTER`, `DROP`, `GRANT`, `VACUUM`, …
    Schema,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Classified {
    pub kind: Kind,
    /// What to call it: the first word in capitals (`UPDATE`), or two for the special cases
    /// (`SELECT INTO`, `COPY FROM`).
    pub command: String,
    /// It can turn a read-only session into a writable one (`SET default_transaction_read_only
    /// = off`, `BEGIN READ WRITE`, `RESET ALL`, `DO` blocks that may run any of those).
    pub unlocks_writes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    /// A keyword or unquoted name, lower-cased.
    Word(String),
    /// `"quoted"`, a string, a number: never a keyword.
    Other,
    Open,
    Close,
    /// Any other punctuation.
    Punct,
}

/// Words and brackets of a statement. Comments are dropped; strings, quoted names and
/// dollar-quoted bodies become one opaque token each, so a `;` or `update` inside them means
/// nothing.
fn tokenize(sql: &str) -> Vec<Token> {
    let chars: Vec<char> = sql.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut tokens = Vec::new();
    let mut i = 0;
    while let Some(c) = at(i) {
        if c.is_whitespace() {
            i += 1;
        } else if c == '-' && at(i + 1) == Some('-') {
            while at(i).is_some_and(|c| c != '\n') {
                i += 1;
            }
        } else if c == '/' && at(i + 1) == Some('*') {
            let mut depth = 1;
            i += 2;
            while depth > 0 && i < chars.len() {
                if at(i) == Some('/') && at(i + 1) == Some('*') {
                    depth += 1;
                    i += 2;
                } else if at(i) == Some('*') && at(i + 1) == Some('/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else if c == '\'' || c == '"' {
            // `E'…'` strings may escape the quote with a backslash.
            let backslash_escapes = c == '\''
                && i > 0
                && matches!(at(i - 1), Some('e' | 'E'))
                && !(i > 1 && at(i - 2).is_some_and(|p| p.is_alphanumeric() || p == '_'));
            i += 1;
            while let Some(d) = at(i) {
                if backslash_escapes && d == '\\' {
                    i += 2;
                } else if d == c {
                    if at(i + 1) == Some(c) {
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            // An `E` right before the quote was read as a word; it is the string's prefix.
            if backslash_escapes && tokens.last() == Some(&Token::Word("e".into())) {
                tokens.pop();
            }
            tokens.push(Token::Other);
        } else if c == '$' && !at(i.wrapping_sub(1)).is_some_and(|p| p.is_alphanumeric()) {
            let tag: String = chars[i..]
                .iter()
                .skip(1)
                .take_while(|c| c.is_alphanumeric() || **c == '_')
                .collect();
            let closing = at(i + 1 + tag.chars().count());
            if closing == Some('$') {
                let delimiter: Vec<char> = format!("${tag}$").chars().collect();
                let body_start = i + delimiter.len();
                let end = (body_start..chars.len())
                    .find(|&j| chars[j..].starts_with(&delimiter))
                    .map_or(chars.len(), |j| j + delimiter.len());
                i = end;
                tokens.push(Token::Other);
            } else {
                // `$1`
                i += 1;
                tokens.push(Token::Other);
            }
        } else if c.is_alphabetic() || c == '_' {
            let start = i;
            while at(i).is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
                i += 1;
            }
            let word: String = chars[start..i].iter().collect();
            tokens.push(Token::Word(word.to_lowercase()));
        } else if c.is_ascii_digit() {
            while at(i).is_some_and(|c| c.is_alphanumeric() || c == '.' || c == '_') {
                i += 1;
            }
            tokens.push(Token::Other);
        } else {
            tokens.push(match c {
                '(' => Token::Open,
                ')' => Token::Close,
                _ => Token::Punct,
            });
            i += 1;
        }
    }
    tokens
}

fn word(token: &Token) -> Option<&str> {
    match token {
        Token::Word(w) => Some(w),
        _ => None,
    }
}

/// The words of the statement that are not inside brackets.
fn top_level_words(tokens: &[Token]) -> Vec<&str> {
    let mut depth = 0usize;
    let mut out = Vec::new();
    for token in tokens {
        match token {
            Token::Open => depth += 1,
            Token::Close => depth = depth.saturating_sub(1),
            Token::Word(w) if depth == 0 => out.push(w.as_str()),
            _ => {}
        }
    }
    out
}

fn has_pair(words: &[&str], a: &str, b: &str) -> bool {
    words.windows(2).any(|pair| pair[0] == a && pair[1] == b)
}

fn make(kind: Kind, command: &str) -> Classified {
    Classified {
        kind,
        command: command.to_uppercase(),
        unlocks_writes: false,
    }
}

/// Words that start a statement; `EXPLAIN ANALYZE` runs what follows it.
const STARTERS: &[&str] = &[
    "select", "insert", "update", "delete", "merge", "with", "values", "create", "refresh",
    "declare", "execute", "table",
];

fn classify_tokens(tokens: &[Token]) -> Classified {
    let Some(first) = tokens.iter().find_map(word) else {
        return make(Kind::Read, "");
    };
    let words = top_level_words(tokens);
    let all_words: Vec<&str> = tokens.iter().filter_map(word).collect();

    let mut classified = match first {
        "select" => {
            if words.contains(&"into") {
                make(Kind::Write, "SELECT INTO")
            } else {
                make(Kind::Read, "SELECT")
            }
        }
        "with" => {
            // A data-modifying statement inside a CTE (`WITH x AS (DELETE … RETURNING *)`).
            match all_words
                .iter()
                .find(|w| matches!(**w, "insert" | "update" | "delete" | "merge"))
            {
                Some(command) => make(Kind::Write, command),
                None if words.contains(&"into") => make(Kind::Write, "SELECT INTO"),
                None => make(Kind::Read, "WITH"),
            }
        }
        "explain" => {
            // Plain EXPLAIN only plans. With ANALYZE the statement runs, so it counts as itself.
            if all_words
                .iter()
                .any(|w| matches!(*w, "analyze" | "analyse"))
            {
                let start = tokens
                    .iter()
                    .position(|t| matches!(t, Token::Word(w) if STARTERS.contains(&w.as_str())));
                match start {
                    Some(at) => classify_tokens(&tokens[at..]),
                    None => make(Kind::Read, "EXPLAIN"),
                }
            } else {
                make(Kind::Read, "EXPLAIN")
            }
        }
        "insert" | "update" | "delete" | "merge" | "truncate" | "call" | "refresh" | "execute" => {
            make(Kind::Write, first)
        }
        "do" => make(Kind::Write, "DO"),
        "copy" => {
            if words.contains(&"from") {
                make(Kind::Write, "COPY FROM")
            } else {
                make(Kind::Read, "COPY TO")
            }
        }
        "create" | "alter" | "drop" | "grant" | "revoke" | "comment" | "reindex" | "cluster"
        | "vacuum" | "security" | "reassign" | "import" | "lock" => make(Kind::Schema, first),
        other => make(Kind::Read, other),
    };

    // Ways to make a read-only session writable again.
    let read_write = has_pair(&all_words, "read", "write");
    let names_the_setting = all_words
        .iter()
        .any(|w| w.ends_with("transaction_read_only"));
    classified.unlocks_writes = match first {
        "set" | "begin" | "start" => read_write || names_the_setting,
        // RESET ALL and DISCARD ALL undo the session's settings, this one included.
        "reset" | "discard" => all_words.contains(&"all") || names_the_setting,
        // A DO block can run anything, including `SET default_transaction_read_only = off`.
        "do" => true,
        "show" => false,
        // `SELECT set_config('default_transaction_read_only', 'off', false)`
        _ => all_words.contains(&"set_config"),
    };
    classified
}

/// Classify one statement (the text of a single statement, as `script::split` gives it).
pub fn classify(statement: &str) -> Classified {
    classify_tokens(&tokenize(statement))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(sql: &str) -> (Kind, String) {
        let c = classify(sql);
        (c.kind, c.command)
    }

    #[test]
    fn plain_statements_are_sorted_by_what_they_do() {
        let cases = [
            ("SELECT 1", Kind::Read, "SELECT"),
            ("  select * from users where id = 1", Kind::Read, "SELECT"),
            ("VALUES (1), (2)", Kind::Read, "VALUES"),
            ("TABLE users", Kind::Read, "TABLE"),
            ("SHOW search_path", Kind::Read, "SHOW"),
            ("BEGIN", Kind::Read, "BEGIN"),
            ("COMMIT", Kind::Read, "COMMIT"),
            ("SET search_path = public", Kind::Read, "SET"),
            ("INSERT INTO t VALUES (1)", Kind::Write, "INSERT"),
            ("update t set a = 1", Kind::Write, "UPDATE"),
            ("DELETE FROM t", Kind::Write, "DELETE"),
            ("TRUNCATE t", Kind::Write, "TRUNCATE"),
            (
                "MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE",
                Kind::Write,
                "MERGE",
            ),
            ("CALL do_it()", Kind::Write, "CALL"),
            ("REFRESH MATERIALIZED VIEW v", Kind::Write, "REFRESH"),
            ("CREATE TABLE t (id int)", Kind::Schema, "CREATE"),
            ("alter table t add column c int", Kind::Schema, "ALTER"),
            ("DROP TABLE t", Kind::Schema, "DROP"),
            ("GRANT SELECT ON t TO bob", Kind::Schema, "GRANT"),
            ("VACUUM t", Kind::Schema, "VACUUM"),
            ("COMMENT ON TABLE t IS 'x'", Kind::Schema, "COMMENT"),
        ];
        for (sql, expected, command) in cases {
            assert_eq!(kind(sql), (expected, command.to_owned()), "{sql}");
        }
    }

    #[test]
    fn comments_and_case_do_not_hide_the_command() {
        assert_eq!(kind("-- tidy up\nDELETE FROM t").0, Kind::Write);
        assert_eq!(
            kind("/* a /* nested */ comment */ drop table t").0,
            Kind::Schema
        );
        assert_eq!(kind("   \n\tUpDaTe t SET a = 1").0, Kind::Write);
    }

    #[test]
    fn words_inside_strings_and_names_are_not_commands() {
        assert_eq!(kind("SELECT 'DELETE FROM t; DROP TABLE t'").0, Kind::Read);
        assert_eq!(kind("SELECT \"update\" FROM t").0, Kind::Read);
        assert_eq!(kind("SELECT $$ insert into x $$").0, Kind::Read);
        assert_eq!(kind("SELECT $tag$ delete $tag$ AS body").0, Kind::Read);
        assert_eq!(kind("SELECT E'it\\'s an update'").0, Kind::Read);
        assert_eq!(kind("SELECT 1 -- insert into t").0, Kind::Read);
    }

    #[test]
    fn select_into_and_data_modifying_ctes_write() {
        assert_eq!(
            kind("SELECT * INTO backup FROM t"),
            (Kind::Write, "SELECT INTO".into())
        );
        // INTO inside brackets is not the table clause.
        assert_eq!(kind("SELECT (SELECT 1 INTO x) FROM t").0, Kind::Read);
        assert_eq!(
            kind("WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone"),
            (Kind::Write, "DELETE".into())
        );
        assert_eq!(
            kind("with moved as (insert into a select * from b returning 1) select count(*) from moved").0,
            Kind::Write
        );
        assert_eq!(
            kind("WITH x AS (SELECT 1) SELECT * FROM x"),
            (Kind::Read, "WITH".into())
        );
    }

    #[test]
    fn explain_only_counts_when_it_runs_the_statement() {
        assert_eq!(kind("EXPLAIN DELETE FROM t").0, Kind::Read);
        assert_eq!(kind("EXPLAIN SELECT 1").0, Kind::Read);
        assert_eq!(
            kind("EXPLAIN ANALYZE DELETE FROM t"),
            (Kind::Write, "DELETE".into())
        );
        assert_eq!(
            kind("EXPLAIN (ANALYZE, BUFFERS) UPDATE t SET a = 1"),
            (Kind::Write, "UPDATE".into())
        );
        assert_eq!(kind("EXPLAIN ANALYZE SELECT 1").0, Kind::Read);
    }

    #[test]
    fn copy_depends_on_the_direction() {
        assert_eq!(
            kind("COPY t FROM '/tmp/x.csv'"),
            (Kind::Write, "COPY FROM".into())
        );
        assert_eq!(kind("COPY t TO '/tmp/x.csv'").0, Kind::Read);
        assert_eq!(kind("COPY (SELECT * FROM t) TO STDOUT").0, Kind::Read);
    }

    #[test]
    fn ways_to_leave_read_only_are_found() {
        let unlocking = [
            "SET default_transaction_read_only = off",
            "set session default_transaction_read_only to false",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "BEGIN READ WRITE",
            "START TRANSACTION READ WRITE",
            "begin transaction isolation level serializable, read write",
            "SET TRANSACTION READ WRITE",
            "RESET default_transaction_read_only",
            "RESET ALL",
            "DISCARD ALL",
            "DO $$ BEGIN SET default_transaction_read_only = off; END $$",
            "SELECT set_config('default_transaction_read_only', 'off', false)",
            "SELECT pg_catalog.set_config('default_transaction_read_only', 'off', false)",
        ];
        for sql in unlocking {
            assert!(classify(sql).unlocks_writes, "{sql}");
        }
        let harmless = [
            "SHOW default_transaction_read_only",
            "SELECT current_setting('default_transaction_read_only')",
            "BEGIN",
            "BEGIN READ ONLY",
            "SET search_path = public",
            "SET TRANSACTION READ ONLY",
            "RESET search_path",
            "SELECT 1",
            "UPDATE t SET read_write = 1",
        ];
        for sql in harmless {
            assert!(!classify(sql).unlocks_writes, "{sql}");
        }
    }

    #[test]
    fn an_empty_statement_is_a_read() {
        assert_eq!(kind(""), (Kind::Read, String::new()));
        assert_eq!(kind("-- nothing here"), (Kind::Read, String::new()));
    }
}
