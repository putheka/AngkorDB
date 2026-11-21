//! Query history and saved queries: SQLite file, no server needed (ANG-33).

use std::time::Instant;

use angkordb_lib::models::history::SavedQueryInput;
use angkordb_lib::storage::history::{HIDDEN, HistoryStore, MAX_HISTORY, redact};

fn store() -> HistoryStore {
    HistoryStore::in_memory().unwrap()
}

#[test]
fn history_survives_reopening_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.sqlite");
    {
        let store = HistoryStore::open(&path).unwrap();
        store.add("a", "SELECT 1", 1000.0, 5, true).unwrap();
        store.add("a", "SELEC 2", 2000.0, 7, false).unwrap();
    }
    let store = HistoryStore::open(&path).unwrap();
    let all = store.search("", None, 50, 0).unwrap();
    assert_eq!(all.len(), 2);
    // Newest first, with everything that was recorded.
    assert_eq!(all[0].sql, "SELEC 2");
    assert!(!all[0].ok);
    assert_eq!(all[0].duration_ms, 7);
    assert_eq!(all[1].sql, "SELECT 1");
    assert_eq!(all[1].ran_at, 1000.0);
    assert_eq!(all[1].connection_id, "a");
}

#[test]
fn rerunning_the_same_statement_is_one_entry() {
    let s = store();
    s.add("a", "SELECT 1", 1.0, 5, true).unwrap();
    s.add("a", "  SELECT 1  ", 2.0, 9, false).unwrap();
    let all = s.search("", None, 50, 0).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].ran_at, 2.0);
    assert_eq!(all[0].duration_ms, 9);
    assert!(!all[0].ok);

    // Another connection's identical statement is its own entry; so is one in between.
    s.add("b", "SELECT 1", 3.0, 1, true).unwrap();
    s.add("a", "SELECT 2", 4.0, 1, true).unwrap();
    s.add("a", "SELECT 1", 5.0, 1, true).unwrap();
    assert_eq!(s.search("", None, 50, 0).unwrap().len(), 4);
}

#[test]
fn blank_statements_are_not_recorded() {
    let s = store();
    s.add("a", "   \n ", 1.0, 0, true).unwrap();
    assert!(s.search("", None, 50, 0).unwrap().is_empty());
}

#[test]
fn search_matches_every_word_in_any_case_and_filters_by_connection() {
    let s = store();
    s.add("a", "SELECT * FROM Users WHERE id = 1", 1.0, 1, true)
        .unwrap();
    s.add("a", "SELECT * FROM orders", 2.0, 1, true).unwrap();
    s.add("b", "SELECT name FROM users", 3.0, 1, true).unwrap();

    let hits = s.search("users select", None, 50, 0).unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(s.search("users", Some("a"), 50, 0).unwrap().len(), 1);
    assert_eq!(s.search("nothing like this", None, 50, 0).unwrap().len(), 0);
    assert_eq!(s.search("", Some("b"), 50, 0).unwrap().len(), 1);
}

#[test]
fn search_treats_like_wildcards_as_plain_text() {
    let s = store();
    s.add("a", "SELECT 100 AS pct_done", 1.0, 1, true).unwrap();
    s.add("a", "SELECT 'a%b'", 2.0, 1, true).unwrap();
    s.add("a", "SELECT 'path\\to'", 3.0, 1, true).unwrap();

    assert_eq!(s.search("pct_done", None, 50, 0).unwrap().len(), 1);
    // `_` must not match any character: "pctXdone" is not a hit for "pct_done".
    assert_eq!(s.search("pct_", None, 50, 0).unwrap().len(), 1);
    assert_eq!(s.search("a%b", None, 50, 0).unwrap().len(), 1);
    assert_eq!(s.search("%", None, 50, 0).unwrap().len(), 1);
    assert_eq!(s.search("\\to", None, 50, 0).unwrap().len(), 1);
    assert_eq!(s.search("_", None, 50, 0).unwrap().len(), 1);
}

#[test]
fn search_pages_and_clamps_the_limit() {
    let s = store();
    for i in 0..30 {
        s.add("a", &format!("SELECT {i}"), f64::from(i), 1, true)
            .unwrap();
    }
    let first = s.search("", None, 10, 0).unwrap();
    let second = s.search("", None, 10, 10).unwrap();
    assert_eq!(first.len(), 10);
    assert_eq!(first[0].sql, "SELECT 29");
    assert_eq!(second[0].sql, "SELECT 19");
    assert_eq!(
        s.search("", None, 0, 0).unwrap().len(),
        1,
        "limit is at least 1"
    );
}

#[test]
fn only_the_last_ten_thousand_are_kept_and_search_is_fast() {
    let s = store();
    for i in 0..(MAX_HISTORY + 250) {
        s.add(
            "a",
            &format!("SELECT {i} FROM some_table"),
            f64::from(i),
            1,
            true,
        )
        .unwrap();
    }
    let started = Instant::now();
    let all = s.search("", None, 1000, 0).unwrap();
    assert_eq!(all.len(), 1000);
    let needle = s.search("select 5000 ", None, 50, 0).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(needle.len(), 1);
    assert!(
        elapsed.as_millis() < 500,
        "search over 10k entries took {elapsed:?}"
    );

    // 10 000 rows; the oldest 250 are gone, so the oldest left is number 250.
    let mut count = 0;
    let mut offset = 0;
    let mut oldest = String::new();
    loop {
        let page = s.search("", None, 1000, offset).unwrap();
        let Some(last) = page.last() else { break };
        oldest = last.sql.clone();
        count += page.len();
        offset += 1000;
    }
    assert_eq!(count, MAX_HISTORY as usize);
    assert_eq!(oldest, "SELECT 250 FROM some_table");
}

#[test]
fn delete_and_clear() {
    let s = store();
    s.add("a", "SELECT 1", 1.0, 1, true).unwrap();
    s.add("a", "SELECT 2", 2.0, 1, true).unwrap();
    s.add("b", "SELECT 3", 3.0, 1, true).unwrap();

    let newest = s.search("", Some("a"), 5, 0).unwrap()[0].id;
    s.delete(newest).unwrap();
    assert_eq!(s.search("", Some("a"), 5, 0).unwrap().len(), 1);

    s.clear(Some("a")).unwrap();
    assert!(s.search("", Some("a"), 5, 0).unwrap().is_empty());
    assert_eq!(s.search("", None, 5, 0).unwrap().len(), 1);

    s.clear(None).unwrap();
    assert!(s.search("", None, 5, 0).unwrap().is_empty());
}

#[test]
fn statements_with_passwords_are_never_stored() {
    for sql in [
        "CREATE ROLE app LOGIN PASSWORD 'hunter2'",
        "  alter   user app with password 'x'",
        "ALTER ROLE app ENCRYPTED PASSWORD 'md5abc'",
        "create group g password 'p'",
        // A comment in front, or in the middle, does not hide it.
        "/* note */ ALTER ROLE app PASSWORD 'p'",
        "-- change it\nALTER USER app PASSWORD 'p'",
        "/* a /* nested */ b */ create user u password 'p'",
        "ALTER ROLE app PASSWORD /* hidden */ 'p'",
        "ALTER ROLE app PASSWORD\n'p'",
        "ALTER USER app WITH PASSWORD'p'",
        "ALTER ROLE app PASSWORD $$p$$",
        // Other places a password can be written.
        "CREATE USER MAPPING FOR bob SERVER s OPTIONS (user 'bob', password 'secret')",
        "ALTER SERVER s OPTIONS (ADD password 'secret')",
        "CREATE SUBSCRIPTION s CONNECTION 'host=h password=secret dbname=d' PUBLICATION p",
        "CREATE SUBSCRIPTION s CONNECTION 'password=secret host=h' PUBLICATION p",
        "SELECT dblink_connect('host=h user=u password=secret')",
        "DO $$ BEGIN CREATE ROLE x PASSWORD 'p'; END $$",
        "UPDATE users SET password = 'plain'",
        "UPDATE users SET \"password\" = 'plain'",
        // Whatever form the value takes, a role or server statement with a password is hidden.
        "ALTER ROLE app PASSWORD NULL",
        "ALTER ROLE app PASSWORD U&'\\0070'",
        "ALTER ROLE app PASSWORD N'p'",
        "DO $$ BEGIN EXECUTE format('CREATE ROLE %I PASSWORD %L', 'a', 'b'); END $$",
        "ALTER USER app /* ' */ PASSWORD 'p'",
        "SELECT '/*'; ALTER ROLE a PASSWORD /* c */ 'p'",
        "SELECT '--'; ALTER ROLE a PASSWORD -- c\n'p'",
        "ALTER ROLE app PASSWORD $tag$p$tag$ -- /*",
        // A password written in a comment or a string is still a password.
        "/* ALTER ROLE x PASSWORD 'p' */ SELECT 1",
        "SELECT '-- ALTER ROLE x PASSWORD ''p'''",
    ] {
        assert_eq!(redact(sql), HIDDEN, "{sql}");
    }
    for sql in [
        "CREATE ROLE reader",
        "ALTER ROLE app SET search_path = x",
        "SELECT 'password' FROM t",
        "SELECT password, name FROM users",
        "SELECT * FROM users WHERE name = 'x'",
        "INSERT INTO users (password) VALUES ('x')",
        "SELECT passwords FROM t WHERE reset_password_token IS NULL",
        "-- password: see the vault\nSELECT 1",
    ] {
        assert_eq!(redact(sql), sql, "{sql}");
    }

    let s = store();
    s.add(
        "a",
        "CREATE ROLE app LOGIN PASSWORD 'hunter2'",
        1.0,
        1,
        true,
    )
    .unwrap();
    s.add(
        "a",
        "/* x */ ALTER USER app PASSWORD 'hunter3'",
        2.0,
        1,
        true,
    )
    .unwrap();
    let all = s.search("", None, 5, 0).unwrap();
    assert!(all.iter().all(|e| e.sql == HIDDEN));
    assert!(s.search("hunter", None, 5, 0).unwrap().is_empty());
}

fn input(name: &str, folder: &str, connection: Option<&str>) -> SavedQueryInput {
    SavedQueryInput {
        id: None,
        connection_id: connection.map(str::to_owned),
        name: name.into(),
        folder: folder.into(),
        sql: format!("SELECT '{name}'"),
    }
}

#[test]
fn saved_queries_are_created_listed_changed_and_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("history.sqlite");
    let (kept_id, gone_id);
    {
        let s = HistoryStore::open(&path).unwrap();
        let kept = s
            .save(&input("Orders today", "Reports", Some("a")))
            .unwrap();
        let gone = s.save(&input("Scratch", "", None)).unwrap();
        s.save(&input("Other db", "Reports", Some("b"))).unwrap();
        kept_id = kept.id;
        gone_id = gone.id;
        assert_eq!(kept.folder, "Reports");
        assert!(kept.created_at > 0.0);

        // For connection a: its own and the ones for every connection, folder then name.
        let for_a = s.saved(Some("a")).unwrap();
        let names: Vec<_> = for_a.iter().map(|q| q.name.as_str()).collect();
        assert_eq!(names, ["Scratch", "Orders today"]);
        assert_eq!(s.saved(None).unwrap().len(), 3);

        // Rename, move to another folder, change the text.
        let mut change = input("Orders (renamed)", " Archive ", Some("a"));
        change.id = Some(kept.id);
        change.sql = "SELECT 2".into();
        let changed = s.save(&change).unwrap();
        assert_eq!(changed.id, kept.id);
        assert_eq!(changed.name, "Orders (renamed)");
        assert_eq!(changed.folder, "Archive", "the folder is trimmed");
        assert_eq!(changed.sql, "SELECT 2");
        assert_eq!(changed.created_at, kept.created_at);

        s.delete_saved(gone.id).unwrap();
    }
    // They were written to the file.
    let s = HistoryStore::open(&path).unwrap();
    let all = s.saved(None).unwrap();
    assert!(all.iter().any(|q| q.id == kept_id));
    assert!(all.iter().all(|q| q.id != gone_id));
}

#[test]
fn saving_needs_a_name_and_some_sql_and_an_existing_query_to_change() {
    let s = store();
    let blank_name = s.save(&input("  ", "", None)).unwrap_err();
    assert!(blank_name.to_string().contains("name"), "{blank_name}");

    let mut no_sql = input("x", "", None);
    no_sql.sql = " \n".into();
    assert!(s.save(&no_sql).is_err());

    let mut ghost = input("x", "", None);
    ghost.id = Some(999);
    assert!(s.save(&ghost).is_err());
}
