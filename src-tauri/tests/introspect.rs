//! Reading the structure of the seeded dev database (`dev/seed.sql`).

mod common;

use std::time::{Duration, Instant};

use angkordb_lib::db::introspect;
use angkordb_lib::db::session::Session;
use angkordb_lib::models::schema::{
    ColumnIdentity, ColumnInfo, DbObject, ForeignKeyRef, ObjectKind, RowIdentity, TableDescription,
};
use common::open_or_skip;

fn find<'a>(objects: &'a [DbObject], name: &str, kind: ObjectKind) -> &'a DbObject {
    objects
        .iter()
        .find(|o| o.name == name && o.kind == kind)
        .unwrap_or_else(|| {
            let names: Vec<_> = objects
                .iter()
                .map(|o| format!("{:?} {}", o.kind, o.name))
                .collect();
            panic!("{kind:?} {name} not listed in {names:?}")
        })
}

fn names(objects: &[DbObject], kind: ObjectKind) -> Vec<&str> {
    objects
        .iter()
        .filter(|o| o.kind == kind)
        .map(|o| o.name.as_str())
        .collect()
}

fn column<'a>(table: &'a TableDescription, name: &str) -> &'a ColumnInfo {
    table
        .columns
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("no column {name} in {}", table.name))
}

async fn describe(session: &Session, schema: &str, table: &str) -> TableDescription {
    introspect::describe_table(&session.meta().await.unwrap(), schema, table)
        .await
        .unwrap_or_else(|e| panic!("describe {schema}.{table}: {e:?}"))
}

async fn current_database(session: &Session) -> String {
    let client = session.meta().await.unwrap();
    let row = client
        .query_one("SELECT current_database()", &[])
        .await
        .unwrap();
    row.get(0)
}

async fn identity_of(session: &Session, schema: &str, table: &str) -> RowIdentity {
    describe(session, schema, table).await.identity
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_owned()).collect()
}

#[tokio::test]
async fn lists_databases_without_templates_and_marks_the_current_one() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let databases = introspect::list_databases(&session.meta().await.unwrap())
        .await
        .unwrap();
    let names: Vec<_> = databases.iter().map(|d| d.name.as_str()).collect();

    assert!(
        names.contains(&"angkordb_dev") && names.contains(&"postgres"),
        "{names:?}"
    );
    assert!(
        !names.contains(&"template0") && !names.contains(&"template1"),
        "{names:?}"
    );
    let current: Vec<_> = databases
        .iter()
        .filter(|d| d.is_current)
        .map(|d| d.name.as_str())
        .collect();
    assert_eq!(current, ["angkordb_dev"]);
}

#[tokio::test]
async fn lists_user_schemas_public_first_and_system_schemas_on_request() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    let user = introspect::list_schemas(&client, false).await.unwrap();
    let names: Vec<_> = user.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names[0], "public", "{names:?}");
    assert!(names.contains(&"billing"));
    assert!(
        names
            .iter()
            .all(|n| !n.starts_with("pg_") && *n != "information_schema"),
        "system schemas leaked: {names:?}"
    );
    assert!(user.iter().all(|s| !s.is_system));
    assert_eq!(user[0].owner, "angkor");

    let all = introspect::list_schemas(&client, true).await.unwrap();
    let system: Vec<_> = all
        .iter()
        .filter(|s| s.is_system)
        .map(|s| s.name.as_str())
        .collect();
    assert!(
        system.contains(&"pg_catalog") && system.contains(&"information_schema"),
        "{system:?}"
    );
    assert!(all.len() > user.len());
}

#[tokio::test]
async fn lists_the_objects_of_the_public_schema() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let objects = introspect::list_objects(&session.meta().await.unwrap(), "public")
        .await
        .unwrap();

    assert_eq!(
        names(&objects, ObjectKind::Table),
        [
            "app_settings",
            "event_log",
            "metrics_big",
            "order_items",
            "orders",
            "short_codes",
            "users"
        ]
    );
    assert_eq!(names(&objects, ObjectKind::View), ["user_order_totals"]);
    assert_eq!(names(&objects, ObjectKind::EnumType), ["user_status"]);

    // Row estimates come from the ANALYZE at the end of the seed.
    assert_eq!(
        find(&objects, "users", ObjectKind::Table).row_estimate,
        Some(205.0)
    );
    assert_eq!(
        find(&objects, "orders", ObjectKind::Table).row_estimate,
        Some(1000.0)
    );
    let big = find(&objects, "metrics_big", ObjectKind::Table)
        .row_estimate
        .unwrap();
    assert!(
        (900_000.0..1_100_000.0).contains(&big),
        "metrics_big estimate {big}"
    );
    assert_eq!(
        find(&objects, "user_order_totals", ObjectKind::View).row_estimate,
        None
    );

    assert!(objects.iter().all(|o| o.schema == "public"));
}

#[tokio::test]
async fn functions_show_their_signature_and_extension_functions_are_hidden() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let objects = introspect::list_objects(&session.meta().await.unwrap(), "public")
        .await
        .unwrap();

    // citext (installed in `public`) adds dozens of functions; none of them may show up.
    assert_eq!(
        names(&objects, ObjectKind::Function),
        ["greet", "order_total", "touch_updated_at"]
    );

    let greet = find(&objects, "greet", ObjectKind::Function);
    assert_eq!(
        greet.detail.as_deref(),
        Some("(p_name text DEFAULT 'world'::text) → text")
    );
    let total = find(&objects, "order_total", ObjectKind::Function);
    assert_eq!(
        total.detail.as_deref(),
        Some("(p_order_id bigint) → numeric")
    );
    assert_eq!(
        find(&objects, "touch_updated_at", ObjectKind::Function)
            .detail
            .as_deref(),
        Some("() → trigger")
    );
}

#[tokio::test]
async fn sequences_hide_identity_sequences_but_keep_explicit_ones() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    // `orders.id` is bigserial (its own sequence); users/metrics_big use identity columns.
    let public = introspect::list_objects(&client, "public").await.unwrap();
    assert_eq!(names(&public, ObjectKind::Sequence), ["orders_id_seq"]);

    let billing = introspect::list_objects(&client, "billing").await.unwrap();
    assert_eq!(names(&billing, ObjectKind::Sequence), ["invoice_no_seq"]);
    assert_eq!(names(&billing, ObjectKind::Table), ["invoices"]);
    assert_eq!(
        names(&billing, ObjectKind::MaterializedView),
        ["monthly_revenue"]
    );
}

#[tokio::test]
async fn an_unknown_or_empty_schema_lists_nothing() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let objects = introspect::list_objects(&session.meta().await.unwrap(), "no_such_schema")
        .await
        .unwrap();
    assert!(objects.is_empty());
}

#[tokio::test]
async fn describes_every_kind_of_column_in_users() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let users = describe(&session, "public", "users").await;

    assert_eq!(users.kind, ObjectKind::Table);
    assert_eq!(
        users.comment.as_deref(),
        Some("Every tricky Postgres type in one place")
    );
    assert_eq!(users.columns.len(), 23);
    assert!(
        users
            .columns
            .iter()
            .enumerate()
            .all(|(i, c)| usize::from(c.position) == i + 1)
    );

    let id = column(&users, "id");
    assert_eq!(
        (id.type_name.as_str(), id.base_type.as_str()),
        ("bigint", "bigint")
    );
    assert!(id.is_primary_key && !id.nullable);
    assert_eq!(id.identity, Some(ColumnIdentity::Always));
    assert_eq!(id.default_value, None);

    assert_eq!(
        column(&users, "uuid").default_value.as_deref(),
        Some("gen_random_uuid()")
    );
    assert_eq!(
        column(&users, "created_at").default_value.as_deref(),
        Some("now()")
    );
    assert_eq!(column(&users, "email").type_name, "citext");

    // Length and precision stay in `type_name`; `base_type` is what edits cast to (ANG-8 D7).
    let name = column(&users, "name");
    assert_eq!(
        (name.type_name.as_str(), name.base_type.as_str()),
        ("character varying(100)", "character varying")
    );
    assert!(name.nullable);
    let balance = column(&users, "balance");
    assert_eq!(
        (balance.type_name.as_str(), balance.base_type.as_str()),
        ("numeric(20,6)", "numeric")
    );
    assert_eq!(balance.default_value.as_deref(), Some("0"));

    assert_eq!(column(&users, "tags").type_name, "text[]");
    assert_eq!(column(&users, "status").type_name, "user_status");
    assert_eq!(
        column(&users, "status").default_value.as_deref(),
        Some("'active'::user_status")
    );
    assert_eq!(column(&users, "active_period").type_name, "tstzrange");
    assert_eq!(
        column(&users, "big_counter").comment.as_deref(),
        Some("Values above 2^53 to catch JS float precision loss")
    );

    assert!(users.columns.iter().filter(|c| c.is_primary_key).count() == 1);
    assert!(
        users
            .columns
            .iter()
            .all(|c| !c.generated && c.foreign_keys.is_empty())
    );
    assert_eq!(
        users.identity,
        RowIdentity::PrimaryKey {
            columns: strings(&["id"])
        }
    );
}

#[tokio::test]
async fn describes_foreign_keys_including_across_schemas() {
    let Some(session) = open_or_skip().await else {
        return;
    };

    let orders = describe(&session, "public", "orders").await;
    assert_eq!(
        column(&orders, "user_id").foreign_keys,
        [ForeignKeyRef {
            constraint: "orders_user_id_fkey".into(),
            schema: "public".into(),
            table: "users".into(),
            column: "id".into(),
        }]
    );
    assert!(column(&orders, "id").foreign_keys.is_empty());

    let invoices = describe(&session, "billing", "invoices").await;
    let order_ref = &column(&invoices, "order_id").foreign_keys;
    assert_eq!(
        (order_ref[0].schema.as_str(), order_ref[0].table.as_str()),
        ("public", "orders")
    );
    assert!(
        column(&invoices, "invoice_no")
            .default_value
            .as_deref()
            .unwrap()
            .contains("invoice_no_seq")
    );
}

#[tokio::test]
async fn a_composite_primary_key_keeps_its_column_order() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let items = describe(&session, "public", "order_items").await;

    assert_eq!(
        items.identity,
        RowIdentity::PrimaryKey {
            columns: strings(&["order_id", "line_no"])
        }
    );
    assert!(column(&items, "order_id").is_primary_key && column(&items, "line_no").is_primary_key);
    assert!(!column(&items, "qty").is_primary_key);
    assert_eq!(column(&items, "order_id").foreign_keys[0].table, "orders");
}

#[tokio::test]
async fn row_identity_follows_the_rules_for_tables_without_a_primary_key() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    // No key at all, with duplicate rows → ctid.
    assert_eq!(
        describe(&session, "public", "event_log").await.identity,
        RowIdentity::Ctid
    );
    // No primary key but a NOT NULL unique column.
    assert_eq!(
        describe(&session, "public", "app_settings").await.identity,
        RowIdentity::UniqueIndex {
            columns: strings(&["key"])
        }
    );
    assert_eq!(
        describe(&session, "public", "short_codes").await.identity,
        RowIdentity::PrimaryKey {
            columns: strings(&["code"])
        }
    );
}

#[tokio::test]
async fn views_and_materialized_views_are_described_and_read_only() {
    let Some(session) = open_or_skip().await else {
        return;
    };

    let view = describe(&session, "public", "user_order_totals").await;
    assert_eq!(view.kind, ObjectKind::View);
    let names: Vec<_> = view.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["user_id", "email", "orders", "total_spent"]);
    assert!(matches!(&view.identity, RowIdentity::ReadOnly { reason } if reason.contains("Views")));

    let matview = describe(&session, "billing", "monthly_revenue").await;
    assert_eq!(matview.kind, ObjectKind::MaterializedView);
    assert_eq!(column(&matview, "revenue").type_name, "numeric");
    assert!(
        matches!(&matview.identity, RowIdentity::ReadOnly { reason } if reason.contains("Materialized"))
    );
}

#[tokio::test]
async fn describing_something_that_is_not_a_table_or_view_is_not_found() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();
    // Missing table, an index, a sequence and a function name all fail the same way.
    for (schema, name) in [
        ("public", "no_such_table"),
        ("public", "users_pkey"),
        ("public", "orders_id_seq"),
        ("public", "greet"),
        ("nope", "users"),
    ] {
        let err = introspect::describe_table(&client, schema, name)
            .await
            .unwrap_err();
        assert_eq!(err.code(), "NOT_FOUND", "{schema}.{name}: {err:?}");
        assert!(err.message().contains(name), "{}", err.message());
    }
}

/// Tables that exercise the identity rules and odd names, in a throwaway schema.
const SCRATCH_SQL: &str = r#"
    CREATE TABLE {s}.pick_smallest_unique (a int NOT NULL, b int NOT NULL, c int NOT NULL,
        UNIQUE (a, b), UNIQUE (c));
    CREATE TABLE {s}.nullable_unique (x int UNIQUE);
    CREATE TABLE {s}.partial_unique (y int NOT NULL);
    CREATE UNIQUE INDEX ON {s}.partial_unique (y) WHERE y > 0;
    CREATE TABLE {s}.expression_unique (z text NOT NULL);
    CREATE UNIQUE INDEX ON {s}.expression_unique ((lower(z)));
    CREATE TABLE {s}.deferrable_unique (d int NOT NULL, UNIQUE (d) DEFERRABLE INITIALLY DEFERRED);
    CREATE TABLE {s}.partitioned (id int NOT NULL) PARTITION BY RANGE (id);
    CREATE TABLE {s}.partitioned_1 PARTITION OF {s}.partitioned FOR VALUES FROM (0) TO (10);
    CREATE TABLE {s}.parent (a int, b int, PRIMARY KEY (a, b));
    CREATE TABLE {s}.parent_a (a int PRIMARY KEY);
    CREATE TABLE {s}.child (pa int, pb int, other int,
        FOREIGN KEY (pa, pb) REFERENCES {s}.parent (a, b),
        FOREIGN KEY (other) REFERENCES {s}.parent_a (a));
    CREATE TABLE {s}.generated_cols (a int, g int GENERATED ALWAYS AS (a + 1) STORED,
        by_default int GENERATED BY DEFAULT AS IDENTITY);
    CREATE TABLE {s}."Mixed ""Case"" name" ("Odd ""col""" int, "select" text DEFAULT 'it''s');
"#;

#[tokio::test]
async fn identity_edge_cases_and_odd_names_in_a_scratch_schema() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang15_scratch";
    let client = session.meta().await.unwrap();
    client
        .batch_execute(&format!(
            "DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema};"
        ))
        .await
        .unwrap();
    client
        .batch_execute(&SCRATCH_SQL.replace("{s}", schema))
        .await
        .unwrap();
    drop(client);

    // Never analyzed → no estimate (not -1, not 0).
    let objects = introspect::list_objects(&session.meta().await.unwrap(), schema)
        .await
        .unwrap();
    assert_eq!(
        find(&objects, "nullable_unique", ObjectKind::Table).row_estimate,
        None
    );
    assert_eq!(
        find(&objects, "partitioned", ObjectKind::PartitionedTable).row_estimate,
        None
    );

    // Fewest columns wins among eligible unique indexes.
    assert_eq!(
        identity_of(&session, schema, "pick_smallest_unique").await,
        RowIdentity::UniqueIndex {
            columns: strings(&["c"])
        }
    );
    // Not usable as an identity: nullable, partial, expression, deferrable.
    for table in [
        "nullable_unique",
        "partial_unique",
        "expression_unique",
        "deferrable_unique",
    ] {
        assert_eq!(
            identity_of(&session, schema, table).await,
            RowIdentity::Ctid,
            "{table}"
        );
    }
    // A partitioned table without a key can't use ctid.
    assert!(matches!(
        identity_of(&session, schema, "partitioned").await,
        RowIdentity::ReadOnly { .. }
    ));
    assert_eq!(
        identity_of(&session, schema, "partitioned_1").await,
        RowIdentity::Ctid
    );

    // Composite foreign key: each column points at its own target column, in order.
    let child = describe(&session, schema, "child").await;
    let pa = &column(&child, "pa").foreign_keys[0];
    let pb = &column(&child, "pb").foreign_keys[0];
    assert_eq!((pa.table.as_str(), pa.column.as_str()), ("parent", "a"));
    assert_eq!((pb.table.as_str(), pb.column.as_str()), ("parent", "b"));
    assert_eq!(pa.constraint, pb.constraint);
    assert_eq!(column(&child, "other").foreign_keys[0].table, "parent_a");

    // Generated and identity columns.
    let generated = describe(&session, schema, "generated_cols").await;
    assert!(column(&generated, "g").generated);
    assert_eq!(
        column(&generated, "g").default_value.as_deref(),
        Some("(a + 1)")
    );
    assert_eq!(
        column(&generated, "by_default").identity,
        Some(ColumnIdentity::ByDefault)
    );
    assert!(!column(&generated, "a").generated);

    // Identifiers are bound parameters, so quotes, spaces and keywords are fine.
    let odd = describe(&session, schema, "Mixed \"Case\" name").await;
    assert_eq!(odd.name, "Mixed \"Case\" name");
    assert_eq!(column(&odd, "Odd \"col\"").type_name, "integer");
    assert_eq!(
        column(&odd, "select").default_value.as_deref(),
        Some("'it''s'::text")
    );
    assert_eq!(odd.identity, RowIdentity::Ctid);

    // A malicious name is just a name that doesn't exist.
    let client = session.meta().await.unwrap();
    let err = introspect::describe_table(&client, "public", "users'; DROP TABLE users; --")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "NOT_FOUND");
    client
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();
    let count: i64 = client
        .query_one("SELECT count(*) FROM public.users", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 205);
}

#[tokio::test]
async fn a_schema_with_500_tables_lists_in_under_300_ms() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let schema = "ang15_perf";
    let client = session.meta().await.unwrap();
    let mut sql = format!("DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema};");
    for i in 0..500 {
        sql += &format!("CREATE TABLE {schema}.t{i:03} (id int PRIMARY KEY, name text);");
    }
    for i in 0..20 {
        sql += &format!("CREATE VIEW {schema}.v{i:02} AS SELECT * FROM {schema}.t{i:03};");
    }
    client.batch_execute(&sql).await.unwrap();

    // Best of three, so one slow moment on a busy machine doesn't decide the result.
    let mut best = Duration::MAX;
    let mut count = 0;
    for _ in 0..3 {
        let started = Instant::now();
        let objects = introspect::list_objects(&client, schema).await.unwrap();
        best = best.min(started.elapsed());
        count = objects.len();
    }
    client
        .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
        .await
        .unwrap();

    assert_eq!(count, 520);
    assert!(best < Duration::from_millis(300), "listing took {best:?}");
    eprintln!("list_objects of 520 objects: {best:?}");
}

#[tokio::test]
async fn switching_database_opens_a_new_session_and_keeps_the_old_one() {
    let Some(session) = open_or_skip().await else {
        return;
    };

    let other = session.switch_database("postgres").await.unwrap();
    assert_eq!(other.config().database, "postgres");
    assert_eq!(other.config().id, session.config().id);
    assert!(other.info().server_version.starts_with("16"));

    assert_eq!(current_database(&other).await, "postgres");
    assert_eq!(current_database(&session).await, "angkordb_dev");

    // The databases list follows the session it is asked on.
    let listed = introspect::list_databases(&other.meta().await.unwrap())
        .await
        .unwrap();
    let marked: Vec<_> = listed
        .iter()
        .filter(|d| d.is_current)
        .map(|d| d.name.as_str())
        .collect();
    assert_eq!(marked, ["postgres"]);

    // A database that doesn't exist: the server's error, and the old session still works.
    let err = session
        .switch_database("no_such_database")
        .await
        .err()
        .expect("must fail");
    assert_eq!(
        err.pg_code(),
        Some("3D000"),
        "invalid_catalog_name: {err:?}"
    );
    assert_eq!(current_database(&session).await, "angkordb_dev");
}

#[tokio::test]
async fn enum_values_come_in_declared_order_and_other_types_have_none() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();

    // `users.status` is the enum `user_status`: its type OID is the column's.
    let users = describe(&session, "public", "users").await;
    let status = column(&users, "status");
    let labels = introspect::enum_values(&client, status.type_oid)
        .await
        .unwrap();
    assert_eq!(labels, ["active", "invited", "suspended"]);

    // Not enums: a built-in type, and an OID that doesn't exist.
    let text = column(&users, "bio");
    assert!(
        introspect::enum_values(&client, text.type_oid)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        introspect::enum_values(&client, 4_000_000_000)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn lists_the_foreign_keys_that_point_at_a_table() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let client = session.meta().await.unwrap();
    let keys = |schema: &'static str, table: &'static str| {
        let client = &client;
        async move {
            introspect::incoming_foreign_keys(client, schema, table)
                .await
                .unwrap()
                .into_iter()
                .map(|k| (k.schema, k.table, k.columns, k.referenced_columns))
                .collect::<Vec<_>>()
        }
    };
    let strings = |items: &[&str]| items.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();

    // users <- orders <- order_items and billing.invoices (across schemas).
    assert_eq!(
        keys("public", "users").await,
        [(
            "public".into(),
            "orders".into(),
            strings(&["user_id"]),
            strings(&["id"])
        )]
    );
    assert_eq!(
        keys("public", "orders").await,
        [
            (
                "billing".into(),
                "invoices".into(),
                strings(&["order_id"]),
                strings(&["id"])
            ),
            (
                "public".into(),
                "order_items".into(),
                strings(&["order_id"]),
                strings(&["id"])
            ),
        ]
    );
    // Nothing points at order_items, and an unknown table is just empty.
    assert!(keys("public", "order_items").await.is_empty());
    assert!(keys("public", "nope").await.is_empty());

    // A composite key keeps its columns in constraint order, whatever the table's column order.
    client
        .batch_execute(
            "DROP SCHEMA IF EXISTS ang27_fk CASCADE; CREATE SCHEMA ang27_fk;
             CREATE TABLE ang27_fk.parent (a int, b int, c text, PRIMARY KEY (a, b));
             CREATE TABLE ang27_fk.child (id int PRIMARY KEY, y int, x int,
               CONSTRAINT child_fk FOREIGN KEY (x, y) REFERENCES ang27_fk.parent (a, b));",
        )
        .await
        .unwrap();
    let composite = introspect::incoming_foreign_keys(&client, "ang27_fk", "parent")
        .await
        .unwrap();
    client
        .batch_execute("DROP SCHEMA ang27_fk CASCADE")
        .await
        .unwrap();
    assert_eq!(composite.len(), 1);
    assert_eq!(composite[0].constraint, "child_fk");
    assert_eq!(composite[0].columns, strings(&["x", "y"]));
    assert_eq!(composite[0].referenced_columns, strings(&["a", "b"]));
}
