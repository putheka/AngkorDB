//! Paging, sorting, filtering and counting against the seeded dev database (`dev/seed.sql`).

mod common;

use std::time::Instant;

use angkordb_lib::db::rows::{count_matching, count_rows, fetch_rows};
use angkordb_lib::db::session::Session;
use angkordb_lib::models::rows::{
    Filter, FilterOp, RowCount, RowPage, RowQuery, SortDir, SortSpec,
};
use angkordb_lib::models::schema::RowIdentity;
use common::open_or_skip;

fn query(schema: &str, table: &str) -> RowQuery {
    RowQuery {
        schema: schema.into(),
        table: table.into(),
        limit: 100,
        offset: 0,
        sort: vec![],
        filters: vec![],
        raw_where: None,
    }
}

fn filter(column: &str, op: FilterOp, values: &[&str]) -> Filter {
    Filter {
        column: column.into(),
        op,
        values: values.iter().map(|v| (*v).to_owned()).collect(),
    }
}

fn sort(column: &str, dir: SortDir) -> SortSpec {
    SortSpec {
        column: column.into(),
        dir,
    }
}

async fn page(session: &Session, query: &RowQuery) -> RowPage {
    let client = session.meta().await.unwrap();
    fetch_rows(&client, query)
        .await
        .unwrap_or_else(|e| panic!("fetch {}.{}: {e:?}", query.schema, query.table))
}

async fn count(session: &Session, table: &str, filters: &[Filter], exact: bool) -> RowCount {
    let client = session.meta().await.unwrap();
    count_rows(&client, "public", table, filters, None, exact)
        .await
        .unwrap()
}

/// The cells of one column, in row order.
fn cells(page: &RowPage, column: &str) -> Vec<Option<String>> {
    let i = page
        .columns
        .iter()
        .position(|c| c.name == column)
        .unwrap_or_else(|| panic!("no column {column}"));
    page.rows.iter().map(|row| row[i].clone()).collect()
}

fn some(values: &[&str]) -> Vec<Option<String>> {
    values.iter().map(|v| Some((*v).to_owned())).collect()
}

async fn table_exists(session: &Session, name: &str) -> bool {
    let client = session.meta().await.unwrap();
    client
        .query_one("SELECT to_regclass($1) IS NOT NULL", &[&name])
        .await
        .unwrap()
        .get(0)
}

#[tokio::test]
async fn first_page_has_typed_columns_text_cells_and_the_identity() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let mut q = query("public", "users");
    q.limit = 5;
    let result = page(&session, &q).await;

    assert_eq!(result.rows.len(), 5);
    assert!(result.has_more, "users has 205 rows");
    assert!(result.ctids.is_empty());
    assert_eq!(
        result.identity,
        RowIdentity::PrimaryKey {
            columns: vec!["id".into()]
        }
    );
    assert!(result.rows.iter().all(|r| r.len() == result.columns.len()));
    assert_eq!(result.columns[0].name, "id");
    assert_eq!(result.columns[0].type_name, "bigint");
    let balance = result.columns.iter().find(|c| c.name == "balance").unwrap();
    assert_eq!(balance.type_name, "numeric(20,6)");
    // Primary key order by default.
    assert_eq!(cells(&result, "id"), some(&["1", "2", "3", "4", "5"]));
}

#[tokio::test]
async fn values_arrive_as_exact_text() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let mut q = query("public", "users");
    q.filters = vec![filter("email", FilterOp::Eq, &["dara@example.com"])];
    let result = page(&session, &q).await;

    assert_eq!(result.rows.len(), 1);
    // Above 2^53: a JS number would round this.
    assert_eq!(cells(&result, "big_counter"), some(&["9007199254740993"]));
    assert_eq!(cells(&result, "balance"), some(&["1234.567891"]));
    assert_eq!(cells(&result, "tags"), some(&["{admin,early-adopter}"]));
    assert_eq!(cells(&result, "is_admin"), some(&["true"]));
}

#[tokio::test]
async fn null_is_none_and_an_empty_string_is_not() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = page(&session, &query("public", "app_settings")).await;
    // Unique index identity → ordered by key: beta, page_size, theme.
    assert_eq!(cells(&result, "key"), some(&["beta", "page_size", "theme"]));
    assert_eq!(
        cells(&result, "value"),
        vec![None, Some("500".into()), Some("system".into())]
    );
    assert_eq!(
        result.identity,
        RowIdentity::UniqueIndex {
            columns: vec!["key".into()]
        }
    );
}

#[tokio::test]
async fn paging_reports_whether_there_is_another_page() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let mut q = query("public", "short_codes");
    q.limit = 2;
    let first = page(&session, &q).await;
    assert_eq!(cells(&first, "code"), some(&["KH", "TH"]));
    assert!(first.has_more);

    q.offset = 2;
    let second = page(&session, &q).await;
    assert_eq!(cells(&second, "code"), some(&["USA"]));
    assert!(!second.has_more);

    q.offset = 50;
    assert!(page(&session, &q).await.rows.is_empty());
}

#[tokio::test]
async fn sorting_overrides_the_key_order() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let mut q = query("public", "short_codes");
    q.sort = vec![sort("label", SortDir::Desc)];
    let result = page(&session, &q).await;
    assert_eq!(cells(&result, "code"), some(&["USA", "TH", "KH"]));

    // Two keys: country ascending, then id descending.
    let mut q = query("public", "users");
    q.limit = 3;
    q.filters = vec![filter("country", FilterOp::IsNotNull, &[])];
    q.sort = vec![sort("country", SortDir::Asc), sort("id", SortDir::Desc)];
    let result = page(&session, &q).await;
    let countries = cells(&result, "country");
    assert!(countries.windows(2).all(|w| w[0] <= w[1]), "{countries:?}");
}

#[tokio::test]
async fn every_operator_filters_server_side() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let ids = |result: &RowPage| cells(result, "id");

    let run = |filters: Vec<Filter>| {
        let session = &session;
        async move {
            let mut q = query("public", "users");
            q.filters = filters;
            page(session, &q).await
        }
    };

    assert_eq!(
        ids(&run(vec![filter("id", FilterOp::Eq, &["3"])]).await),
        some(&["3"])
    );
    assert_eq!(
        ids(&run(vec![filter("id", FilterOp::In, &["1", "2", "99999"])]).await),
        some(&["1", "2"])
    );
    assert_eq!(
        ids(&run(vec![filter("id", FilterOp::Between, &["4", "6"])]).await),
        some(&["4", "5", "6"])
    );
    assert_eq!(
        ids(&run(vec![
            filter("id", FilterOp::Ge, &["10"]),
            filter("id", FilterOp::Lt, &["13"]),
            filter("id", FilterOp::Ne, &["11"]),
        ])
        .await),
        some(&["10", "12"])
    );
    // LIKE works on any type, ILIKE ignores case.
    let like = run(vec![filter("email", FilterOp::ILike, &["DARA@%"])]).await;
    assert_eq!(cells(&like, "email"), some(&["dara@example.com"]));
    let like_id = run(vec![filter("id", FilterOp::Like, &["20_"])]).await;
    assert_eq!(
        ids(&like_id),
        some(&["200", "201", "202", "203", "204", "205"])
    );
    // NULL tests.
    let nulls = run(vec![filter("name", FilterOp::IsNull, &[])]).await;
    assert!(cells(&nulls, "name").iter().all(Option::is_none));
    let non_nulls = run(vec![
        filter("name", FilterOp::IsNotNull, &[]),
        filter("id", FilterOp::Le, &["2"]),
    ])
    .await;
    assert!(cells(&non_nulls, "name").iter().all(Option::is_some));
    // Enum, uuid, date and timestamptz columns take their literals as text.
    let status = run(vec![filter("status", FilterOp::Eq, &["suspended"])]).await;
    assert!(!status.rows.is_empty());
    assert!(
        cells(&status, "status")
            .iter()
            .all(|s| s.as_deref() == Some("suspended"))
    );
    let born = run(vec![filter("birthday", FilterOp::Gt, &["1990-01-01"])]).await;
    assert!(!born.rows.is_empty());
    let created = run(vec![filter(
        "created_at",
        FilterOp::Lt,
        &["2000-01-01T00:00:00Z"],
    )])
    .await;
    assert!(created.rows.is_empty());
}

#[tokio::test]
async fn sql_injection_through_filter_values_is_harmless() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let nasty = [
        "'; DROP TABLE users; --",
        "x' OR '1'='1",
        "\"; DROP TABLE users; --",
        "1; DELETE FROM users",
        "%' ; TRUNCATE users; --",
    ];
    for text in nasty {
        for (column, op) in [
            ("email", FilterOp::Eq),
            ("email", FilterOp::Like),
            ("email", FilterOp::ILike),
            ("name", FilterOp::Ne),
        ] {
            let mut q = query("public", "users");
            q.filters = vec![filter(column, op, &[text])];
            let result = page(&session, &q).await;
            // `!=` matches (almost) everything, the rest match nothing: either way no error.
            if op != FilterOp::Ne {
                assert!(result.rows.is_empty(), "{op:?} {text}");
            }
        }
        let mut q = query("public", "users");
        q.filters = vec![filter("email", FilterOp::In, &[text, "a"])];
        assert!(page(&session, &q).await.rows.is_empty());
    }
    assert!(table_exists(&session, "public.users").await);
    assert_eq!(count(&session, "users", &[], true).await.count, 205.0);
}

#[tokio::test]
async fn injection_through_names_is_rejected_before_any_sql_runs() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    // Unknown column in a filter or a sort.
    let mut q = query("public", "users");
    q.filters = vec![filter("id\" = 1 OR \"1", FilterOp::IsNull, &[])];
    let err = fetch_rows(&client, &q).await.unwrap_err();
    assert_eq!(err.code(), "VALIDATION");

    let mut q = query("public", "users");
    q.sort = vec![sort("id; DROP TABLE users", SortDir::Asc)];
    assert_eq!(
        fetch_rows(&client, &q).await.unwrap_err().code(),
        "VALIDATION"
    );

    // Unknown table, even when the name is valid SQL that would hurt.
    for name in ["users\"; DROP TABLE users; --", "nope"] {
        let err = fetch_rows(&client, &query("public", name))
            .await
            .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND", "{name}");
    }
    drop(client);
    assert!(table_exists(&session, "public.users").await);
}

#[tokio::test]
async fn raw_where_filters_and_cannot_write() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    let mut q = query("public", "short_codes");
    q.raw_where = Some("WHERE code <> 'KH';".into());
    let result = fetch_rows(&client, &q).await.unwrap();
    assert_eq!(cells(&result, "code"), some(&["TH", "USA"]));

    // Combines with the filter bar.
    q.filters = vec![filter("code", FilterOp::Ne, &["TH"])];
    let result = fetch_rows(&client, &q).await.unwrap();
    assert_eq!(cells(&result, "code"), some(&["USA"]));

    // A trailing comment can't break the statement.
    q.filters.clear();
    q.raw_where = Some("code = 'KH' -- only Cambodia".into());
    assert_eq!(fetch_rows(&client, &q).await.unwrap().rows.len(), 1);

    // A second statement is refused...
    q.raw_where = Some("true); DELETE FROM public.short_codes; --".into());
    let err = fetch_rows(&client, &q).await.unwrap_err();
    assert_eq!(err.code(), "POSTGRES", "{err:?}");

    // ...and so is anything that writes, thanks to the read-only transaction.
    q.raw_where = Some("nextval('billing.invoice_no_seq') > 0".into());
    let err = fetch_rows(&client, &q).await.unwrap_err();
    assert_eq!(err.pg_code(), Some("25006"), "{err:?}");

    // The connection went back to a clean state after the errors.
    q.raw_where = None;
    assert_eq!(fetch_rows(&client, &q).await.unwrap().rows.len(), 3);
    drop(client);
    assert_eq!(count(&session, "short_codes", &[], true).await.count, 3.0);
}

#[tokio::test]
async fn a_value_of_the_wrong_type_is_a_postgres_error_not_a_crash() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();
    let mut q = query("public", "users");
    q.filters = vec![filter("id", FilterOp::Eq, &["abc"])];
    let err = fetch_rows(&client, &q).await.unwrap_err();
    assert_eq!(
        err.pg_code(),
        Some("22P02"),
        "invalid_text_representation: {err:?}"
    );

    // Same connection, next request works.
    q.filters.clear();
    q.limit = 1;
    assert_eq!(fetch_rows(&client, &q).await.unwrap().rows.len(), 1);
}

#[tokio::test]
async fn tables_without_a_key_return_their_ctids() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let result = page(&session, &query("public", "event_log")).await;
    assert_eq!(result.identity, RowIdentity::Ctid);
    assert_eq!(result.rows.len(), 4);
    assert_eq!(result.ctids.len(), 4);
    assert!(
        result
            .ctids
            .iter()
            .all(|c| c.starts_with('(') && c.ends_with(')'))
    );
    // The two identical rows are told apart by ctid.
    assert_ne!(result.ctids[0], result.ctids[1]);
    // ctid is not a visible column.
    assert!(result.columns.iter().all(|c| c.name != "ctid"));
    assert!(result.rows.iter().all(|r| r.len() == result.columns.len()));
}

#[tokio::test]
async fn views_and_other_schemas_can_be_browsed_read_only() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let view = page(&session, &query("public", "user_order_totals")).await;
    assert!(matches!(view.identity, RowIdentity::ReadOnly { .. }));
    assert!(!view.rows.is_empty());

    let invoices = page(&session, &query("billing", "invoices")).await;
    assert!(!invoices.rows.is_empty());
}

#[tokio::test]
async fn counts_are_estimated_unless_exact_or_filtered() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let estimate = count(&session, "metrics_big", &[], false).await;
    assert!(!estimate.exact);
    assert!(
        (900_000.0..=1_100_000.0).contains(&estimate.count),
        "{}",
        estimate.count
    );

    let exact = count(&session, "metrics_big", &[], true).await;
    assert!(exact.exact);
    assert_eq!(exact.count, 1_000_000.0);

    // A filter can't be estimated from statistics: always exact.
    let filtered = count(
        &session,
        "metrics_big",
        &[filter("sensor", FilterOp::Eq, &["sensor-7"])],
        false,
    )
    .await;
    assert!(filtered.exact);
    assert_eq!(filtered.count, 20_000.0);

    // Views have no statistics.
    let client = session.meta().await.unwrap();
    let view = count_rows(&client, "public", "user_order_totals", &[], None, false)
        .await
        .unwrap();
    assert!(view.exact);
}

#[tokio::test]
async fn the_first_page_of_a_million_rows_is_fast() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let mut q = query("public", "metrics_big");
    q.limit = 100;
    // Warm up: connection, catalog caches.
    page(&session, &q).await;

    let started = Instant::now();
    let first = page(&session, &q).await;
    let elapsed = started.elapsed();
    assert_eq!(first.rows.len(), 100);
    assert!(first.has_more);
    eprintln!("first page of metrics_big: {elapsed:?}");
    assert!(elapsed.as_millis() < 100, "took {elapsed:?}");

    // A deep page uses OFFSET, which is slower but still bounded.
    q.offset = 500_000;
    let started = Instant::now();
    let deep = page(&session, &q).await;
    eprintln!("page at offset 500000: {:?}", started.elapsed());
    assert_eq!(deep.rows.len(), 100);
    assert_eq!(deep.rows[0][0].as_deref(), Some("500001"));
}

#[tokio::test]
async fn count_matching_stops_counting_at_the_cap() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();
    let eq = |column: &str, value: &str| vec![filter(column, FilterOp::Eq, &[value])];

    // One user's orders: exact when under the cap.
    let few = count_matching(&client, "public", "order_items", &eq("order_id", "1"), 1000)
        .await
        .unwrap();
    assert_eq!((few.count, few.capped), (3, false));

    // order_items has 3000 rows: a filter that matches all of them is cut at the cap.
    let many = count_matching(&client, "public", "order_items", &[], 100)
        .await
        .unwrap();
    assert_eq!((many.count, many.capped), (100, true));

    // Exactly the cap is not "more than the cap".
    let exact = count_matching(&client, "public", "order_items", &eq("order_id", "1"), 3)
        .await
        .unwrap();
    assert_eq!((exact.count, exact.capped), (3, false));

    // None, and a value that is not valid for the column is the server's error.
    let none = count_matching(
        &client,
        "public",
        "order_items",
        &eq("order_id", "999999"),
        10,
    )
    .await
    .unwrap();
    assert_eq!((none.count, none.capped), (0, false));
    let bad = count_matching(&client, "public", "order_items", &eq("order_id", "x"), 10)
        .await
        .unwrap_err();
    assert_eq!(bad.pg_code(), Some("22P02"));

    // Names are checked against the catalog, never pasted into the SQL.
    let injected = count_matching(
        &client,
        "public",
        "order_items",
        &eq("order_id\" = 1 --", "1"),
        10,
    )
    .await
    .unwrap_err();
    assert_eq!(injected.code(), "VALIDATION");
}
