//! Structure of tables and views, and the DDL rebuilt from the catalog, against the dev database
//! (see `common`). The DDL is checked the hard way: it is run on empty databases.

mod common;

use angkordb_lib::db::script;
use angkordb_lib::db::session::Session;
use angkordb_lib::db::structure::table_structure;
use angkordb_lib::models::schema::{ColumnIdentity, ObjectKind};
use angkordb_lib::models::structure::{ConstraintKind, Persistence, TableStructure, TriggerState};
use common::{DEV_PASSWORD, dev_config, open_or_skip};

async fn structure(session: &Session, schema: &str, table: &str) -> TableStructure {
    table_structure(&session.meta().await.unwrap(), schema, table)
        .await
        .unwrap_or_else(|e| panic!("structure of {schema}.{table}: {e:?}"))
}

#[tokio::test]
async fn users_has_every_kind_of_column_a_key_a_trigger_and_a_size() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let users = structure(&session, "public", "users").await;
    assert_eq!(users.kind, ObjectKind::Table);
    assert_eq!(users.info.owner, "angkor");
    assert_eq!(
        users.info.comment.as_deref(),
        Some("Every tricky Postgres type in one place")
    );
    assert_eq!(users.info.persistence, Persistence::Permanent);
    assert_eq!(users.info.access_method.as_deref(), Some("heap"));
    assert!(users.info.total_bytes > 0.0);
    assert!(users.info.index_bytes > 0.0);
    assert!(users.info.total_bytes >= users.info.table_bytes);
    let estimate = users.info.row_estimate.expect("the seed ran ANALYZE");
    assert!((estimate - 205.0).abs() < 50.0, "estimated {estimate} rows");

    let column = |name: &str| users.columns.iter().find(|c| c.name == name).unwrap();
    let id = column("id");
    assert_eq!(id.position, 1);
    assert_eq!(id.type_name, "bigint");
    assert_eq!(id.identity, Some(ColumnIdentity::Always));
    assert!(id.is_primary_key);
    assert!(!id.nullable);
    assert_eq!(
        column("uuid").default_value.as_deref(),
        Some("gen_random_uuid()")
    );
    assert_eq!(column("email").type_name, "citext");
    assert_eq!(column("name").type_name, "character varying(100)");
    assert_eq!(column("status").type_name, "user_status");
    assert_eq!(
        column("status").default_value.as_deref(),
        Some("'active'::user_status")
    );
    assert_eq!(column("tags").type_name, "text[]");
    assert_eq!(column("balance").type_name, "numeric(20,6)");
    assert_eq!(
        column("big_counter").comment.as_deref(),
        Some("Values above 2^53 to catch JS float precision loss")
    );
    assert!(column("bio").nullable);

    // Indexes: the key and the two unique columns, each backing a constraint.
    let index = |name: &str| users.indexes.iter().find(|i| i.name == name).unwrap();
    let pkey = index("users_pkey");
    assert!(pkey.primary && pkey.unique && pkey.valid);
    assert_eq!(pkey.method, "btree");
    assert_eq!(pkey.columns, ["id"]);
    assert_eq!(pkey.constraint.as_deref(), Some("users_pkey"));
    // The list shows names the way the connection sees them: `users`, not `public.users`.
    assert!(
        pkey.definition
            .starts_with("CREATE UNIQUE INDEX users_pkey ON"),
        "{}",
        pkey.definition
    );
    assert!(
        pkey.definition.ends_with("USING btree (id)"),
        "{}",
        pkey.definition
    );
    assert!(pkey.size_bytes > 0.0);
    assert_eq!(users.indexes.len(), 3);

    let kinds: Vec<_> = users.constraints.iter().map(|c| c.kind).collect();
    assert_eq!(
        kinds,
        [
            ConstraintKind::PrimaryKey,
            ConstraintKind::Unique,
            ConstraintKind::Unique
        ]
    );
    assert_eq!(users.constraints[0].definition, "PRIMARY KEY (id)");

    // The trigger that keeps updated_at current.
    assert_eq!(users.triggers.len(), 1);
    let trigger = &users.triggers[0];
    assert_eq!(trigger.name, "users_touch_updated_at");
    assert_eq!(trigger.timing, "BEFORE");
    assert_eq!(trigger.events, ["UPDATE"]);
    assert!(trigger.per_row);
    assert_eq!(trigger.function, "public.touch_updated_at");
    assert_eq!(trigger.state, TriggerState::Enabled);
}

#[tokio::test]
async fn orders_shows_serial_check_foreign_key_and_a_partial_index() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let orders = structure(&session, "public", "orders").await;
    let id = orders.columns.iter().find(|c| c.name == "id").unwrap();
    assert_eq!(
        id.default_value.as_deref(),
        Some("nextval('orders_id_seq'::regclass)")
    );
    assert_eq!(id.identity, None);

    let user_id = orders.columns.iter().find(|c| c.name == "user_id").unwrap();
    assert_eq!(user_id.foreign_keys.len(), 1);
    assert_eq!(user_id.foreign_keys[0].table, "users");

    let fk = orders
        .constraints
        .iter()
        .find(|c| c.kind == ConstraintKind::ForeignKey)
        .unwrap();
    assert_eq!(fk.references.as_deref(), Some("public.users"));
    assert_eq!(fk.columns, ["user_id"]);
    assert!(
        fk.definition.contains("ON DELETE CASCADE"),
        "{}",
        fk.definition
    );
    assert!(fk.validated && !fk.deferrable);

    let check = orders
        .constraints
        .iter()
        .find(|c| c.kind == ConstraintKind::Check)
        .unwrap();
    assert!(check.definition.contains("pending"), "{}", check.definition);

    let open = orders
        .indexes
        .iter()
        .find(|i| i.name == "orders_open_idx")
        .unwrap();
    assert!(open.partial);
    assert!(open.constraint.is_none());
    assert!(open.definition.contains("WHERE"), "{}", open.definition);
}

#[tokio::test]
async fn order_items_has_a_composite_key_in_key_order() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let items = structure(&session, "public", "order_items").await;
    let pk = items
        .constraints
        .iter()
        .find(|c| c.kind == ConstraintKind::PrimaryKey)
        .unwrap();
    assert_eq!(pk.columns, ["order_id", "line_no"]);
    let flagged: Vec<_> = items
        .columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.as_str())
        .collect();
    assert_eq!(flagged, ["order_id", "line_no"]);
}

#[tokio::test]
async fn views_and_materialized_views_have_columns_and_a_definition() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let view = structure(&session, "public", "user_order_totals").await;
    assert_eq!(view.kind, ObjectKind::View);
    assert!(
        view.info.row_estimate.is_none(),
        "a view has no row estimate"
    );
    assert!(
        view.ddl
            .starts_with("CREATE VIEW public.user_order_totals AS\nSELECT"),
        "{}",
        view.ddl
    );
    assert!(view.ddl.contains("LEFT JOIN"), "{}", view.ddl);
    assert!(view.constraints.is_empty() && view.triggers.is_empty());
    assert_eq!(
        view.columns
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["user_id", "email", "orders", "total_spent"]
    );

    let matview = structure(&session, "billing", "monthly_revenue").await;
    assert_eq!(matview.kind, ObjectKind::MaterializedView);
    assert_eq!(matview.info.populated, Some(true));
    assert!(
        matview
            .ddl
            .starts_with("CREATE MATERIALIZED VIEW billing.monthly_revenue AS\nSELECT"),
        "{}",
        matview.ddl
    );
    assert!(matview.ddl.contains("WITH DATA;"), "{}", matview.ddl);
    assert!(
        matview
            .prerequisites
            .contains("CREATE SCHEMA IF NOT EXISTS billing;")
    );
}

#[tokio::test]
async fn a_table_in_another_schema_lists_what_it_needs_first() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let invoices = structure(&session, "billing", "invoices").await;
    let needs = &invoices.prerequisites;
    assert!(
        needs.starts_with("CREATE SCHEMA IF NOT EXISTS billing;"),
        "{needs}"
    );
    assert!(
        needs.contains(
            "CREATE SEQUENCE billing.invoice_no_seq AS bigint START WITH 1000 INCREMENT BY 1 \
             MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;"
        ),
        "{needs}"
    );
    // The sequence is not owned by the column, so there is no OWNED BY.
    assert!(!invoices.ddl.contains("OWNED BY"), "{}", invoices.ddl);
    // The foreign key goes after the table, and names the other schema.
    assert!(
        invoices.ddl.contains(
            "ALTER TABLE billing.invoices\n    ADD CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id);"
        ),
        "{}",
        invoices.ddl
    );
    assert!(
        invoices.ddl.contains(
            "CREATE TABLE billing.invoices (\n    id uuid DEFAULT gen_random_uuid() NOT NULL,\n    invoice_no integer DEFAULT nextval('billing.invoice_no_seq'::regclass) NOT NULL,"
        ),
        "{}",
        invoices.ddl
    );

    let users = structure(&session, "public", "users").await;
    // An extension type, an enum, and the function a trigger calls.
    assert!(
        users
            .prerequisites
            .contains("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;")
    );
    assert!(
        users
            .prerequisites
            .contains("CREATE TYPE public.user_status AS ENUM ('active', 'invited', 'suspended');")
    );
    assert!(
        users
            .prerequisites
            .contains("CREATE OR REPLACE FUNCTION public.touch_updated_at()")
    );

    // Serial: the sequence is created first and then handed to the column.
    let orders = structure(&session, "public", "orders").await;
    assert!(
        orders
            .prerequisites
            .contains("CREATE SEQUENCE public.orders_id_seq AS bigint")
    );
    assert!(
        orders
            .ddl
            .contains("ALTER SEQUENCE public.orders_id_seq OWNED BY public.orders.id;")
    );
}

#[tokio::test]
async fn a_missing_table_is_not_found() {
    let Some(session) = open_or_skip().await else {
        return;
    };
    let err = table_structure(&session.meta().await.unwrap(), "public", "no_such_table")
        .await
        .unwrap_err();
    assert_eq!(err.code(), "NOT_FOUND");
}

// ---- The DDL, run on empty databases ----------------------------------------------------------

const PREFIX: &str = "angkordb_ddl_";

/// A database that exists for one test and is dropped at the end.
struct Scratch {
    name: String,
}

impl Scratch {
    async fn create(admin: &Session, label: &str) -> Self {
        let pid = std::process::id();
        let name = format!("{PREFIX}{pid}_{label}");
        let client = admin.meta().await.unwrap();
        // Leftovers of an earlier run that was killed (not those of the tests running now).
        let old = client
            .query(
                "SELECT datname::text FROM pg_database
                  WHERE datname LIKE $1 AND datname NOT LIKE $2",
                &[&format!("{PREFIX}%"), &format!("{PREFIX}{pid}\\_%")],
            )
            .await
            .unwrap();
        for row in old {
            let stale: String = row.get(0);
            let _ = client
                .batch_execute(&format!("DROP DATABASE IF EXISTS \"{stale}\" WITH (FORCE)"))
                .await;
        }
        client
            .batch_execute(&format!("DROP DATABASE IF EXISTS \"{name}\" WITH (FORCE)"))
            .await
            .unwrap();
        client
            .batch_execute(&format!("CREATE DATABASE \"{name}\" TEMPLATE template0"))
            .await
            .unwrap();
        Self { name }
    }

    async fn open(&self) -> Session {
        let mut config = dev_config();
        config.database = self.name.clone();
        Session::open(config, Some(DEV_PASSWORD)).await.unwrap()
    }

    async fn drop_it(self, admin: &Session) {
        let client = admin.meta().await.unwrap();
        client
            .batch_execute(&format!(
                "DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)",
                self.name
            ))
            .await
            .unwrap();
    }
}

/// Run every statement of `sql`; the ones that fail with a code in `tolerate` are skipped.
/// Returns the first other failure as a message.
async fn run_all(session: &Session, sql: &str, tolerate: &[&str]) -> Result<(), String> {
    let client = session.meta().await.unwrap();
    for statement in script::split(sql) {
        let text = &sql[statement.start..statement.end];
        if let Err(e) = client.batch_execute(text).await {
            let code = e.code().map(|c| c.code().to_owned()).unwrap_or_default();
            if !tolerate.contains(&code.as_str()) {
                return Err(format!("{e}\n  in: {text}"));
            }
        }
    }
    Ok(())
}

/// Tables of the dev database, referenced tables first.
async fn seed_tables(session: &Session) -> Vec<(String, String)> {
    let client = session.meta().await.unwrap();
    let tables: Vec<(String, String)> = client
        .query(
            "SELECT n.nspname::text, c.relname::text FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'billing')
              ORDER BY 1, 2",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let edges: Vec<((String, String), (String, String))> = client
        .query(
            "SELECT cn.nspname::text, c.relname::text, pn.nspname::text, p.relname::text
               FROM pg_constraint k
               JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace cn ON cn.oid = c.relnamespace
               JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace pn ON pn.oid = p.relnamespace
              WHERE k.contype = 'f'",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|r| ((r.get(0), r.get(1)), (r.get(2), r.get(3))))
        .collect();

    let mut ordered: Vec<(String, String)> = Vec::new();
    let mut left = tables;
    while !left.is_empty() {
        let ready = left
            .iter()
            .position(|t| {
                edges
                    .iter()
                    .filter(|(child, parent)| child == t && parent != t)
                    .all(|(_, parent)| ordered.contains(parent))
            })
            .expect("foreign keys form a cycle");
        ordered.push(left.remove(ready));
    }
    ordered
}

#[tokio::test]
async fn every_seed_table_s_ddl_runs_on_an_empty_database_and_round_trips() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let tables = seed_tables(&dev).await;
    assert!(tables.len() >= 8, "{tables:?}");
    assert!(tables.iter().any(|t| t.0 == "billing"));

    // 1. Each table alone, in a database with nothing in it: what it needs, then the table and
    //    everything of its own except foreign keys (the tables they point at are not there).
    for (schema, table) in &tables {
        let structure = structure(&dev, schema, table).await;
        let scratch = Scratch::create(&dev, "alone").await;
        let session = scratch.open().await;
        run_all(&session, &structure.prerequisites, &[])
            .await
            .unwrap_or_else(|e| panic!("{schema}.{table} prerequisites on an empty database: {e}"));
        let without_keys: String = script::split(&structure.ddl)
            .iter()
            .map(|s| &structure.ddl[s.start..s.end])
            .filter(|text| !text.contains("FOREIGN KEY"))
            .map(|text| format!("{text};\n"))
            .collect();
        run_all(&session, &without_keys, &[])
            .await
            .unwrap_or_else(|e| panic!("{schema}.{table} on an empty database: {e}"));
        drop(session);
        scratch.drop_it(&dev).await;
    }

    // 2. All of them in one empty database, referenced tables first, foreign keys and all. Then
    //    the DDL of what was built has to be the DDL it was built from.
    let scratch = Scratch::create(&dev, "all").await;
    let session = scratch.open().await;
    let duplicates = ["42710", "42P07", "42723"];
    for (schema, table) in &tables {
        let original = structure(&dev, schema, table).await;
        run_all(&session, &original.prerequisites, &duplicates)
            .await
            .unwrap();
        run_all(&session, &original.ddl, &[])
            .await
            .unwrap_or_else(|e| panic!("{schema}.{table}: {e}"));
    }
    for (schema, table) in &tables {
        let original = structure(&dev, schema, table).await;
        let rebuilt = structure(&session, schema, table).await;
        assert_eq!(
            rebuilt.ddl, original.ddl,
            "{schema}.{table}: the DDL changed on the way"
        );
        assert_eq!(
            rebuilt.prerequisites, original.prerequisites,
            "{schema}.{table}: what it needs changed on the way"
        );
        assert_eq!(
            rebuilt
                .columns
                .iter()
                .map(|c| (&c.name, &c.type_name, c.nullable, &c.default_value))
                .collect::<Vec<_>>(),
            original
                .columns
                .iter()
                .map(|c| (&c.name, &c.type_name, c.nullable, &c.default_value))
                .collect::<Vec<_>>(),
            "{schema}.{table}"
        );
    }
    drop(session);
    scratch.drop_it(&dev).await;
}

/// Things the seed doesn't have: partitions, inheritance, generated columns, other kinds of
/// types, unlogged tables, NOT VALID checks, identity options, collations, disabled triggers,
/// view options and comments everywhere.
const SETUP: &str = r#"
CREATE SCHEMA shop;
CREATE TYPE shop.mood AS ENUM ('sad', 'ok', 'great');
CREATE DOMAIN shop.positive AS integer NOT NULL DEFAULT 1 CONSTRAINT positive_check CHECK (VALUE > 0);
CREATE TYPE shop.pair AS (a integer, b shop.mood);
CREATE TYPE shop.intspan AS RANGE (SUBTYPE = integer);
CREATE FUNCTION shop.slug(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT lower(t) $$;
CREATE FUNCTION shop.audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;

CREATE TABLE shop.items (
  id        integer GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 5 MINVALUE 100 MAXVALUE 100000 CACHE 3 CYCLE) PRIMARY KEY,
  title     text NOT NULL COLLATE "C",
  slug      text GENERATED ALWAYS AS (shop.slug(title)) STORED,
  mood      shop.mood DEFAULT 'ok',
  qty       shop.positive,
  moods     shop.mood[],
  pairs     shop.pair,
  span      shop.intspan,
  price     numeric(10, 2) CONSTRAINT price_positive CHECK (price > 0),
  note      text DEFAULT shop.slug('Note')
) WITH (fillfactor = 70);
ALTER TABLE shop.items ADD CONSTRAINT price_cap CHECK (price < 100000) NOT VALID;
CREATE INDEX items_title_idx ON shop.items (lower(title)) INCLUDE (qty) WHERE qty > 1;
CREATE TRIGGER items_audit AFTER INSERT OR UPDATE ON shop.items FOR EACH ROW EXECUTE FUNCTION shop.audit();
ALTER TABLE shop.items DISABLE TRIGGER items_audit;
COMMENT ON TABLE shop.items IS 'It''s a "table"';
COMMENT ON COLUMN shop.items.title IS 'The title';
COMMENT ON INDEX shop.items_title_idx IS 'Search';
COMMENT ON CONSTRAINT price_positive ON shop.items IS 'No free lunch';

CREATE UNLOGGED TABLE shop.scratch (a integer, b text);

CREATE TABLE shop.events (day date NOT NULL, kind text, PRIMARY KEY (day, kind)) PARTITION BY RANGE (day);
CREATE TABLE shop.events_2026 PARTITION OF shop.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE TABLE shop.events_rest PARTITION OF shop.events DEFAULT;

CREATE TABLE shop.base (id integer PRIMARY KEY, label text);
CREATE TABLE shop.child (extra integer) INHERITS (shop.base);

CREATE VIEW shop.cheap WITH (security_barrier = true) AS SELECT id, title FROM shop.items WHERE price < 10;
CREATE MATERIALIZED VIEW shop.counts AS SELECT mood, count(*) AS n FROM shop.items GROUP BY mood WITH NO DATA;
CREATE UNIQUE INDEX counts_mood ON shop.counts (mood);
"#;

#[tokio::test]
async fn partitions_inheritance_generated_columns_and_other_types_round_trip() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let source = Scratch::create(&dev, "src").await;
    let from = source.open().await;
    run_all(&from, SETUP, &[])
        .await
        .unwrap_or_else(|e| panic!("setup: {e}"));

    let names = [
        ("shop", "items"),
        ("shop", "scratch"),
        ("shop", "events"),
        ("shop", "events_2026"),
        ("shop", "events_rest"),
        ("shop", "base"),
        ("shop", "child"),
        ("shop", "cheap"),
        ("shop", "counts"),
    ];
    let mut originals = Vec::new();
    for (schema, table) in names {
        originals.push(structure(&from, schema, table).await);
    }

    // What it says.
    let items = &originals[0];
    assert!(items.ddl.contains("id integer GENERATED BY DEFAULT AS IDENTITY (START WITH 100 INCREMENT BY 5 MINVALUE 100 MAXVALUE 100000 CACHE 3 CYCLE) NOT NULL"), "{}", items.ddl);
    assert!(
        items
            .ddl
            .contains("title text COLLATE pg_catalog.\"C\" NOT NULL"),
        "{}",
        items.ddl
    );
    assert!(
        items
            .ddl
            .contains("slug text GENERATED ALWAYS AS (shop.slug(title)) STORED"),
        "{}",
        items.ddl
    );
    assert!(
        items.ddl.contains(") WITH (fillfactor=70);"),
        "{}",
        items.ddl
    );
    assert!(
        items
            .ddl
            .contains("ADD CONSTRAINT price_cap CHECK (price < 100000::numeric) NOT VALID;"),
        "{}",
        items.ddl
    );
    assert!(
        items.ddl.contains("DISABLE TRIGGER items_audit;"),
        "{}",
        items.ddl
    );
    assert!(
        items
            .ddl
            .contains("COMMENT ON TABLE shop.items IS 'It''s a \"table\"';"),
        "{}",
        items.ddl
    );
    assert!(
        items
            .ddl
            .contains("COMMENT ON INDEX shop.items_title_idx IS 'Search';"),
        "{}",
        items.ddl
    );
    assert!(
        items
            .ddl
            .contains("COMMENT ON CONSTRAINT price_positive ON shop.items IS 'No free lunch';"),
        "{}",
        items.ddl
    );
    assert!(
        items
            .prerequisites
            .contains("CREATE DOMAIN shop.positive AS integer DEFAULT 1 NOT NULL"),
        "{}",
        items.prerequisites
    );
    assert!(
        items
            .prerequisites
            .contains("CREATE TYPE shop.pair AS (\n    a integer,\n    b shop.mood\n);"),
        "{}",
        items.prerequisites
    );
    assert!(
        items
            .prerequisites
            .contains("CREATE TYPE shop.intspan AS RANGE (SUBTYPE = integer);"),
        "{}",
        items.prerequisites
    );
    assert!(
        items
            .columns
            .iter()
            .any(|c| c.collation.as_deref() == Some("pg_catalog.\"C\"")
                || c.collation.as_deref() == Some("\"C\"")),
        "{:?}",
        items
            .columns
            .iter()
            .map(|c| &c.collation)
            .collect::<Vec<_>>()
    );
    let invalid = items
        .constraints
        .iter()
        .find(|c| c.name == "price_cap")
        .unwrap();
    assert!(!invalid.validated);
    assert_eq!(items.triggers[0].state, TriggerState::Disabled);
    assert_eq!(items.info.options, ["fillfactor=70"]);

    assert_eq!(originals[1].info.persistence, Persistence::Unlogged);
    assert!(
        originals[1]
            .ddl
            .starts_with("CREATE UNLOGGED TABLE shop.scratch (")
    );

    let events = &originals[2];
    assert_eq!(events.kind, ObjectKind::PartitionedTable);
    assert_eq!(events.info.partition_key.as_deref(), Some("RANGE (day)"));
    assert_eq!(
        events.info.partitions,
        ["shop.events_2026", "shop.events_rest"]
    );
    assert!(
        events.ddl.contains("PARTITION BY RANGE (day);"),
        "{}",
        events.ddl
    );
    let part = &originals[3];
    assert_eq!(part.info.parents, ["shop.events"]);
    assert_eq!(
        part.ddl.trim(),
        "CREATE TABLE shop.events_2026 PARTITION OF shop.events\n    FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');"
    );
    assert!(
        originals[4]
            .ddl
            .contains("PARTITION OF shop.events\n    DEFAULT;"),
        "{}",
        originals[4].ddl
    );

    let child = &originals[6];
    assert_eq!(child.info.parents, ["shop.base"]);
    assert!(
        child
            .ddl
            .contains("CREATE TABLE shop.child (\n    extra integer\n)\nINHERITS (shop.base);"),
        "{}",
        child.ddl
    );

    assert!(
        originals[7]
            .ddl
            .starts_with("CREATE VIEW shop.cheap WITH (security_barrier=true) AS\n"),
        "{}",
        originals[7].ddl
    );
    assert!(
        originals[8].ddl.contains("WITH NO DATA;"),
        "{}",
        originals[8].ddl
    );
    assert_eq!(originals[8].info.populated, Some(false));
    assert!(
        originals[8]
            .ddl
            .contains("CREATE UNIQUE INDEX counts_mood ON shop.counts"),
        "{}",
        originals[8].ddl
    );

    // Run in a second empty database, in an order that makes sense, and compare.
    let target = Scratch::create(&dev, "dst").await;
    let to = target.open().await;
    let duplicates = ["42710", "42P07", "42723"];
    for original in &originals {
        run_all(&to, &original.prerequisites, &duplicates)
            .await
            .unwrap_or_else(|e| panic!("{}: {e}", original.name));
    }
    for name in [
        "items",
        "scratch",
        "events",
        "events_2026",
        "events_rest",
        "base",
        "child",
        "cheap",
        "counts",
    ] {
        let original = originals.iter().find(|o| o.name == name).unwrap();
        run_all(&to, &original.ddl, &[])
            .await
            .unwrap_or_else(|e| panic!("{name}: {e}\n{}", original.ddl));
    }
    for original in &originals {
        let rebuilt = structure(&to, "shop", &original.name).await;
        assert_eq!(
            rebuilt.ddl, original.ddl,
            "{}: the DDL changed on the way",
            original.name
        );
    }

    drop(from);
    drop(to);
    source.drop_it(&dev).await;
    target.drop_it(&dev).await;
}

/// Names and text built to break out of generated SQL: dots, quotes, backslashes, line breaks,
/// `--`, `;`, and an enum label and comments that try to end their own string literal.
const HOSTILE: &str = r##"
CREATE SCHEMA "we""ird.sch";
CREATE TYPE "we""ird.sch"."mo""od" AS ENUM ('it''s', 'back\slash', E'quote\\''; DROP TABLE y;--');
CREATE TABLE "we""ird.sch"."evil
DROP TABLE victim;--" (id integer PRIMARY KEY);
CREATE TABLE "we""ird.sch"."t.a""b\c" (
  "col; DROP TABLE x --" "we""ird.sch"."mo""od" DEFAULT 'it''s',
  "a
b" integer,
  holder "we""ird.sch"."evil
DROP TABLE victim;--"
);
COMMENT ON TABLE "we""ird.sch"."t.a""b\c" IS 'back\slash and ''quote'' \''; DROP TABLE z; --';
COMMENT ON COLUMN "we""ird.sch"."t.a""b\c"."a
b" IS E'tricky \\ \'; DROP TABLE v;--';
CREATE INDEX "idx.with""dot" ON "we""ird.sch"."t.a""b\c" ("a
b");
COMMENT ON INDEX "we""ird.sch"."idx.with""dot" IS E'tricky \\ \'; DROP TABLE w;--';
"##;

/// Every statement of `sql` has to be a CREATE, ALTER or COMMENT: nothing else got in.
fn only_creates(sql: &str, what: &str) {
    for statement in script::split(sql) {
        let text = &sql[statement.start..statement.end];
        let first = text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_ascii_uppercase();
        assert!(
            ["CREATE", "ALTER", "COMMENT"].contains(&first.as_str()),
            "{what}: unexpected statement {text:?}"
        );
    }
}

#[tokio::test]
async fn hostile_names_and_text_cannot_break_out_of_the_ddl() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let source = Scratch::create(&dev, "evil_src").await;
    let from = source.open().await;
    run_all(&from, HOSTILE, &[])
        .await
        .unwrap_or_else(|e| panic!("setup: {e}"));

    let evil_name = "evil\nDROP TABLE victim;--";
    let table_name = "t.a\"b\\c";
    let evil = structure(&from, "we\"ird.sch", evil_name).await;
    let table = structure(&from, "we\"ird.sch", table_name).await;

    for (what, s) in [("evil", &evil), ("table", &table)] {
        only_creates(&s.prerequisites, &format!("{what} prerequisites"));
        only_creates(&s.ddl, &format!("{what} ddl"));
        // The row type of another table can't be created from here: it is said in a comment,
        // and the comment stays one line.
        for line in s.prerequisites.lines().filter(|l| l.starts_with("--")) {
            assert!(line.ends_with("must already exist."), "{line:?}");
        }
    }
    // Strings that try to end themselves are written so they can't.
    assert!(
        table.ddl.contains(r"IS E'tricky \\ ''; DROP TABLE v;--';"),
        "{}",
        table.ddl
    );
    assert!(
        table
            .ddl
            .contains(r#""idx.with""dot" IS E'tricky \\ ''; DROP TABLE w;--';"#),
        "{}",
        table.ddl
    );
    assert!(
        table
            .ddl
            .contains(r"E'back\\slash and ''quote'' \\''; DROP TABLE z; --'"),
        "{}",
        table.ddl
    );
    assert!(
        table
            .prerequisites
            .contains(r"E'quote\\''; DROP TABLE y;--'"),
        "{}",
        table.prerequisites
    );

    // And it builds the same thing again somewhere else.
    let target = Scratch::create(&dev, "evil_dst").await;
    let to = target.open().await;
    let duplicates = ["42710", "42P07", "42723"];
    for s in [&evil, &table] {
        run_all(&to, &s.prerequisites, &duplicates)
            .await
            .unwrap_or_else(|e| panic!("{}: {e}", s.name));
        run_all(&to, &s.ddl, &[])
            .await
            .unwrap_or_else(|e| panic!("{}: {e}\n{}", s.name, s.ddl));
    }
    let rebuilt = structure(&to, "we\"ird.sch", table_name).await;
    assert_eq!(rebuilt.ddl, table.ddl);
    // The comment text came through intact, including the part that looks like SQL.
    assert_eq!(
        rebuilt.info.comment.as_deref(),
        Some("back\\slash and 'quote' \\'; DROP TABLE z; --")
    );

    drop(from);
    drop(to);
    source.drop_it(&dev).await;
    target.drop_it(&dev).await;
}
