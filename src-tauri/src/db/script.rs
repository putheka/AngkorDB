//! Split SQL text into statements (ANG-8 D4).
//!
//! A `;` ends a statement unless it sits inside a string (`'…'`, `E'…\'…'`), a quoted
//! identifier (`"…"`), a dollar-quoted body (`$tag$…$tag$`) or a comment (`-- …`, `/* … */`,
//! which nest in Postgres). Not handled: the semicolons inside a `BEGIN ATOMIC … END` function
//! body (psql tracks those; this does not).

/// One statement, as positions in the text it was found in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Statement {
    /// Byte offsets of the first and one past the last significant character: no surrounding
    /// whitespace, and no `;`. A comment in front of the statement belongs to it.
    pub start: usize,
    pub end: usize,
    /// The same two positions in UTF-16 code units.
    pub utf16_start: u32,
    pub utf16_end: u32,
    /// One past the closing `;` (or the end, when there is none).
    utf16_terminated_end: u32,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// All statements of `sql` that contain something besides whitespace and comments.
pub fn split(sql: &str) -> Vec<Statement> {
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    let n = chars.len();
    let ch = |i: usize| chars.get(i).map(|&(_, c)| c);

    let mut utf16_at = Vec::with_capacity(n + 1);
    let mut acc = 0u32;
    for &(_, c) in &chars {
        utf16_at.push(acc);
        acc += c.len_utf16() as u32;
    }
    utf16_at.push(acc);
    let byte_at = |i: usize| chars.get(i).map_or(sql.len(), |&(b, _)| b);

    let mut out = Vec::new();
    let mut start: Option<usize> = None; // char index of the first thing in this statement
    let mut last_end = 0; // char index one past the last thing in it
    let mut has_code = false; // something besides comments
    let mut i = 0;

    let mut finish =
        |start: &mut Option<usize>, last_end: usize, has_code: &mut bool, terminated_end: usize| {
            if let Some(s) = start.take()
                && *has_code
            {
                out.push(Statement {
                    start: byte_at(s),
                    end: byte_at(last_end),
                    utf16_start: utf16_at[s],
                    utf16_end: utf16_at[last_end],
                    utf16_terminated_end: utf16_at[terminated_end],
                });
            }
            *has_code = false;
        };

    while i < n {
        let Some(c) = ch(i) else { break };
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == ';' {
            finish(&mut start, last_end, &mut has_code, i + 1);
            i += 1;
            continue;
        }

        // Where the thing that starts here ends, and whether it counts as code.
        let (end, is_code) = if c == '-' && ch(i + 1) == Some('-') {
            let mut j = i + 2;
            while j < n && ch(j) != Some('\n') {
                j += 1;
            }
            (j, false)
        } else if c == '/' && ch(i + 1) == Some('*') {
            let (mut j, mut depth) = (i + 2, 1);
            while j < n && depth > 0 {
                match (ch(j), ch(j + 1)) {
                    (Some('/'), Some('*')) => {
                        depth += 1;
                        j += 2;
                    }
                    (Some('*'), Some('/')) => {
                        depth -= 1;
                        j += 2;
                    }
                    _ => j += 1,
                }
            }
            (j.min(n), false)
        } else if c == '\'' {
            // E'…' allows backslash escapes; a plain string doesn't.
            let escapes = i > 0
                && matches!(ch(i - 1), Some('E' | 'e'))
                && (i < 2 || !ch(i - 2).is_some_and(is_ident));
            (end_of_quoted(&chars, i, '\'', escapes), true)
        } else if c == '"' {
            (end_of_quoted(&chars, i, '"', false), true)
        } else if c == '$' && (i == 0 || !ch(i - 1).is_some_and(is_ident)) {
            (end_of_dollar_quote(&chars, i).unwrap_or(i + 1), true)
        } else {
            (i + 1, true)
        };

        start.get_or_insert(i);
        last_end = end;
        has_code |= is_code;
        i = end;
    }
    finish(&mut start, last_end, &mut has_code, last_end);
    out
}

/// One past the closing quote of the quoted thing that opens at `open`. A doubled quote is a
/// quote character inside; with `escapes`, so is a backslash plus any character.
fn end_of_quoted(chars: &[(usize, char)], open: usize, quote: char, escapes: bool) -> usize {
    let n = chars.len();
    let ch = |i: usize| chars.get(i).map(|&(_, c)| c);
    let mut j = open + 1;
    while j < n {
        let c = ch(j);
        if escapes && c == Some('\\') {
            j += 2;
        } else if c == Some(quote) {
            if ch(j + 1) == Some(quote) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    n // never closed: it runs to the end
}

/// One past the closing `$tag$` of the dollar-quoted body opening at `open`, or `None` when the
/// `$` here is not the start of one (`$1`, a lone `$`).
fn end_of_dollar_quote(chars: &[(usize, char)], open: usize) -> Option<usize> {
    let n = chars.len();
    let ch = |i: usize| chars.get(i).map(|&(_, c)| c);
    let mut k = open + 1;
    while k < n && ch(k).is_some_and(is_ident) {
        k += 1;
    }
    // `$1` is a parameter, and the tag may not start with a digit.
    if ch(k) != Some('$') || ch(open + 1).is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    let tag: Vec<char> = chars[open..=k].iter().map(|&(_, c)| c).collect();
    let mut j = k + 1;
    while j + tag.len() <= n {
        if chars[j..j + tag.len()]
            .iter()
            .map(|&(_, c)| c)
            .eq(tag.iter().copied())
        {
            return Some(j + tag.len());
        }
        j += 1;
    }
    Some(n) // never closed: it runs to the end
}

/// The statement the cursor belongs to, for "run the current statement". A cursor in the
/// whitespace after a statement (or on its `;`) still means that statement; before the first
/// statement it means the first. `cursor` is a UTF-16 offset.
pub fn statement_at(statements: &[Statement], cursor: u32) -> Option<&Statement> {
    let mut previous = None;
    for statement in statements {
        if cursor < statement.utf16_start {
            return previous.or(Some(statement));
        }
        if cursor <= statement.utf16_terminated_end {
            return Some(statement);
        }
        previous = Some(statement);
    }
    previous
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The text of each statement.
    fn texts(sql: &str) -> Vec<&str> {
        split(sql).iter().map(|s| &sql[s.start..s.end]).collect()
    }

    #[test]
    fn splits_on_semicolons_and_trims() {
        assert_eq!(
            texts("SELECT 1;\n  SELECT 2 ;SELECT 3"),
            ["SELECT 1", "SELECT 2", "SELECT 3"]
        );
    }

    #[test]
    fn empty_input_and_stray_semicolons_give_nothing() {
        assert!(texts("").is_empty());
        assert!(texts("  \n ").is_empty());
        assert!(texts(";;  ;").is_empty());
    }

    #[test]
    fn semicolons_inside_strings_and_identifiers_do_not_split() {
        assert_eq!(
            texts("SELECT 'a;b'; SELECT 2"),
            ["SELECT 'a;b'", "SELECT 2"]
        );
        assert_eq!(
            texts(r#"SELECT "a;b" FROM t; SELECT 2"#),
            [r#"SELECT "a;b" FROM t"#, "SELECT 2"]
        );
        // Doubled quotes are a quote character, not the end of the string.
        assert_eq!(
            texts("SELECT 'it''s; fine'; SELECT 2"),
            ["SELECT 'it''s; fine'", "SELECT 2"]
        );
        assert_eq!(
            texts(r#"SELECT "a"";b"; SELECT 2"#),
            [r#"SELECT "a"";b""#, "SELECT 2"]
        );
    }

    #[test]
    fn backslash_escapes_only_work_in_e_strings() {
        // In an E string, \' does not end the string.
        assert_eq!(
            texts(r"SELECT E'a\';b'; SELECT 2"),
            [r"SELECT E'a\';b'", "SELECT 2"]
        );
        // In a plain string a backslash is just a character: the quote after it closes.
        assert_eq!(
            texts(r"SELECT 'a\'; SELECT 2"),
            [r"SELECT 'a\'", "SELECT 2"]
        );
        // `e` at the end of a longer word is not an E-string prefix.
        assert_eq!(
            texts(r"SELECT name'a\'; SELECT 2"),
            [r"SELECT name'a\'", "SELECT 2"]
        );
    }

    #[test]
    fn dollar_quoted_bodies_are_one_piece() {
        let function =
            "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql";
        assert_eq!(
            texts(&format!("{function}; SELECT f()")),
            [function, "SELECT f()"]
        );
        // Tags must match: $a$ is not closed by $$ or $b$.
        let tagged = "DO $a$ BEGIN PERFORM $$x;y$$; END $a$";
        assert_eq!(texts(&format!("{tagged}; SELECT 1")), [tagged, "SELECT 1"]);
    }

    #[test]
    fn dollar_signs_that_are_not_quotes_are_ordinary() {
        // $1 is a parameter; a$b$c is an identifier.
        assert_eq!(texts("SELECT $1; SELECT $2"), ["SELECT $1", "SELECT $2"]);
        assert_eq!(
            texts("SELECT a$b$c; SELECT 2"),
            ["SELECT a$b$c", "SELECT 2"]
        );
        assert_eq!(texts("SELECT '$'; SELECT 2"), ["SELECT '$'", "SELECT 2"]);
    }

    #[test]
    fn comments_hide_semicolons_and_do_not_make_statements() {
        assert_eq!(
            texts("SELECT 1 -- a; b\n; SELECT 2"),
            ["SELECT 1 -- a; b", "SELECT 2"]
        );
        assert_eq!(
            texts("SELECT /* a; b */ 1; SELECT 2"),
            ["SELECT /* a; b */ 1", "SELECT 2"]
        );
        // Postgres block comments nest.
        assert_eq!(
            texts("SELECT 1 /* a /* b; */ c; */; SELECT 2"),
            ["SELECT 1 /* a /* b; */ c; */", "SELECT 2"]
        );
        // Only comments: nothing to run.
        assert!(texts("-- nothing\n/* here */").is_empty());
        assert!(texts("SELECT 1; -- done").len() == 1);
    }

    #[test]
    fn a_comment_in_front_belongs_to_the_statement_after_it() {
        assert_eq!(
            texts("-- all users\nSELECT * FROM users;"),
            ["-- all users\nSELECT * FROM users"]
        );
    }

    #[test]
    fn unterminated_quotes_run_to_the_end() {
        assert_eq!(texts("SELECT 'oops; SELECT 2"), ["SELECT 'oops; SELECT 2"]);
        assert_eq!(
            texts("SELECT $$oops; SELECT 2"),
            ["SELECT $$oops; SELECT 2"]
        );
        assert_eq!(
            texts("SELECT 1 /* oops; SELECT 2"),
            ["SELECT 1 /* oops; SELECT 2"]
        );
    }

    #[test]
    fn utf16_offsets_count_code_units() {
        // 'ក' is 3 bytes in UTF-8 and 1 unit in UTF-16; '😀' is 4 bytes and 2 units.
        let sql = "SELECT 'ក😀'; SELECT 2";
        let statements = split(sql);
        assert_eq!(statements.len(), 2);
        let (first, second) = (statements[0], statements[1]);
        // SELECT, space, quote, ក, 😀 (2), quote = 6 + 1 + 1 + 1 + 2 + 1.
        assert_eq!((first.utf16_start, first.utf16_end), (0, 12));
        assert_eq!(&sql[second.start..second.end], "SELECT 2");
        // The `;` and a space sit between them.
        assert_eq!((second.utf16_start, second.utf16_end), (14, 22));
        // Bytes differ from units: the same positions in UTF-8.
        assert_eq!(first.end, 12 + 2 + 2); // ក takes 2 more bytes than units, 😀 takes 2 more
    }

    #[test]
    fn statement_at_picks_the_statement_under_the_cursor() {
        //            0         1         2
        //            0123456789012345678901234567 8
        let sql = "SELECT 1;\nSELECT 2;\n\nSELECT 3";
        let s = split(sql);
        let at = |cursor: u32| statement_at(&s, cursor).map(|x| &sql[x.start..x.end]);
        assert_eq!(at(0), Some("SELECT 1"));
        assert_eq!(at(5), Some("SELECT 1"));
        assert_eq!(at(8), Some("SELECT 1")); // right after the text
        assert_eq!(at(9), Some("SELECT 1")); // right after the `;`
        assert_eq!(at(10), Some("SELECT 2")); // start of the next line
        assert_eq!(at(18), Some("SELECT 2"));
        assert_eq!(at(19), Some("SELECT 2")); // after its `;`
        assert_eq!(at(20), Some("SELECT 2")); // the empty line below it: still the one above
        assert_eq!(at(21), Some("SELECT 3"));
        assert_eq!(at(sql.len() as u32), Some("SELECT 3"));
    }

    #[test]
    fn statement_at_handles_edges() {
        assert!(statement_at(&split(""), 0).is_none());
        assert!(statement_at(&split("-- just a comment"), 3).is_none());
        // Before the first statement: the first.
        let sql = "\n\n  SELECT 1";
        let s = split(sql);
        assert_eq!(
            statement_at(&s, 0).map(|x| &sql[x.start..x.end]),
            Some("SELECT 1")
        );
        // Far past the end: the last.
        assert_eq!(
            statement_at(&s, 999).map(|x| &sql[x.start..x.end]),
            Some("SELECT 1")
        );
    }
}
