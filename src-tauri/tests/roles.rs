//! Roles and privileges for real (see `common`). Roles belong to the whole server, so the ones
//! made here are named after the process and dropped at the end.

mod common;

use angkordb_lib::db::privileges::{apply as apply_privileges, defaults, matrix};
use angkordb_lib::db::roles::{apply, list, preview};
use angkordb_lib::db::session::Session;
use angkordb_lib::error::AppError;
use angkordb_lib::models::privileges::{PrivilegeChange, PrivilegeTarget, PrivilegeTargetKind};
use angkordb_lib::models::roles::{
    AlterRole, CreateRole, DropRole, Role, RoleAttributes, RoleOperation, RolePasswordChange,
};
use common::{DEV_PASSWORD, Scratch, dev_config, open_or_skip, run_all};

fn role_name(label: &str) -> String {
    format!("angkordb_role_{}_{label}", std::process::id())
}

fn attrs() -> RoleAttributes {
    RoleAttributes {
        can_login: true,
        superuser: false,
        create_db: false,
        create_role: false,
        inherit: true,
        replication: false,
        bypass_rls: false,
        connection_limit: None,
        valid_until: None,
    }
}

fn create_role(name: &str, password: Option<&str>, member_of: &[String]) -> RoleOperation {
    RoleOperation::Create(CreateRole {
        name: name.into(),
        attributes: attrs(),
        password: password.map(str::to_owned),
        member_of: member_of.to_vec(),
    })
}

async fn run(session: &Session, op: &RoleOperation) -> angkordb_lib::error::AppResult<u32> {
    let client = session.meta().await.unwrap();
    apply(&client, op).await
}

async fn forget(session: &Session, names: &[&str]) {
    let client = session.meta().await.unwrap();
    for name in names {
        let _ = client
            .batch_execute(&format!("DROP ROLE IF EXISTS \"{name}\""))
            .await;
    }
}

async fn find(session: &Session, name: &str) -> Option<Role> {
    let client = session.meta().await.unwrap();
    list(&client)
        .await
        .unwrap()
        .into_iter()
        .find(|r| r.name == name)
}

async fn stored_password(session: &Session, name: &str) -> Option<String> {
    let client = session.meta().await.unwrap();
    client
        .query_one(
            "SELECT rolpassword FROM pg_authid WHERE rolname = $1",
            &[&name],
        )
        .await
        .unwrap()
        .get(0)
}

async fn login(role: &str, password: &str) -> angkordb_lib::error::AppResult<Session> {
    let mut config = dev_config();
    config.user = role.into();
    Session::open(config, Some(password)).await
}

#[tokio::test]
async fn a_password_reaches_the_server_only_as_a_verifier_and_still_logs_in() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let name = role_name("login");
    forget(&dev, &[&name]).await;
    let secret = "s3cret'pass\\word \"x\"";

    run(&dev, &create_role(&name, Some(secret), &[]))
        .await
        .unwrap();
    let stored = stored_password(&dev, &name).await.unwrap();
    assert!(stored.starts_with("SCRAM-SHA-256$4096:"), "{stored}");
    assert!(!stored.contains(secret));
    // The plain password works, so it really is the verifier of that password.
    login(&name, secret).await.unwrap().close().await;
    assert!(login(&name, "wrong").await.is_err());

    // A new password replaces it; the old one stops working.
    let change = |password| {
        RoleOperation::Alter(AlterRole {
            name: name.clone(),
            new_name: None,
            attributes: attrs(),
            password,
            member_of: vec![],
            previous_member_of: vec![],
        })
    };
    run(
        &dev,
        &change(RolePasswordChange::Set {
            value: "second".into(),
        }),
    )
    .await
    .unwrap();
    assert!(login(&name, secret).await.is_err());
    login(&name, "second").await.unwrap().close().await;
    // Keep leaves it alone.
    run(&dev, &change(RolePasswordChange::Keep)).await.unwrap();
    login(&name, "second").await.unwrap().close().await;
    // Clear removes it.
    run(&dev, &change(RolePasswordChange::Clear)).await.unwrap();
    assert_eq!(stored_password(&dev, &name).await, None);

    forget(&dev, &[&name]).await;
}

#[tokio::test]
async fn attributes_memberships_and_a_new_name_are_applied_and_listed() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (group, member, renamed) = (
        role_name("group"),
        role_name("member"),
        role_name("renamed"),
    );
    forget(&dev, &[&member, &renamed, &group]).await;
    run(
        &dev,
        &RoleOperation::Create(CreateRole {
            name: group.clone(),
            attributes: RoleAttributes {
                can_login: false,
                ..attrs()
            },
            password: None,
            member_of: vec![],
        }),
    )
    .await
    .unwrap();
    run(&dev, &create_role(&member, None, &[])).await.unwrap();

    let before = find(&dev, &member).await.unwrap();
    assert!(before.can_login && !before.create_db && before.connection_limit.is_none());
    assert!(before.member_of.is_empty() && !before.predefined);

    run(
        &dev,
        &RoleOperation::Alter(AlterRole {
            name: member.clone(),
            new_name: Some(renamed.clone()),
            attributes: RoleAttributes {
                create_db: true,
                connection_limit: Some(3),
                valid_until: Some("2031-02-03".into()),
                ..attrs()
            },
            password: RolePasswordChange::Keep,
            member_of: vec![group.clone()],
            previous_member_of: vec![],
        }),
    )
    .await
    .unwrap();
    assert!(find(&dev, &member).await.is_none());
    let after = find(&dev, &renamed).await.unwrap();
    assert!(after.create_db);
    assert_eq!(after.connection_limit, Some(3));
    assert!(
        after
            .valid_until
            .as_deref()
            .unwrap()
            .starts_with("2031-02-03")
    );
    assert_eq!(after.member_of, std::slice::from_ref(&group));

    // Taking it out of the group and clearing the limit and the expiry.
    run(
        &dev,
        &RoleOperation::Alter(AlterRole {
            name: renamed.clone(),
            new_name: None,
            attributes: attrs(),
            password: RolePasswordChange::Keep,
            member_of: vec![],
            previous_member_of: vec![group.clone()],
        }),
    )
    .await
    .unwrap();
    let cleared = find(&dev, &renamed).await.unwrap();
    assert!(cleared.member_of.is_empty() && !cleared.create_db);
    assert_eq!(
        (cleared.connection_limit, cleared.valid_until),
        (None, None)
    );

    // The listing marks what ships with PostgreSQL and who is asking.
    let client = dev.meta().await.unwrap();
    let all = list(&client).await.unwrap();
    assert!(
        all.iter()
            .any(|r| r.name == "pg_read_all_data" && r.predefined)
    );
    assert!(
        all.iter()
            .any(|r| r.name == "angkor" && r.is_current && r.superuser)
    );

    forget(&dev, &[&renamed, &group]).await;
}

#[tokio::test]
async fn a_failed_change_leaves_nothing_behind() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let name = role_name("atomic");
    forget(&dev, &[&name]).await;
    // The second statement can't work: the group does not exist.
    let error = run(
        &dev,
        &create_role(&name, None, &["angkordb_no_such_group".into()]),
    )
    .await
    .unwrap_err();
    assert!(matches!(error, AppError::Postgres { .. }), "{error:?}");
    assert!(find(&dev, &name).await.is_none());
    // And the connection is usable afterwards.
    assert!(list(&dev.meta().await.unwrap()).await.is_ok());
}

#[tokio::test]
async fn dropping_a_role_that_owns_something_needs_a_new_owner() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let (owner, heir) = (role_name("owner"), role_name("heir"));
    forget(&dev, &[&owner, &heir]).await;
    let scratch = Scratch::create(&dev, "roles_drop").await;
    let db = scratch.open().await;
    run(&dev, &create_role(&owner, None, &[])).await.unwrap();
    run(&dev, &create_role(&heir, None, &[])).await.unwrap();
    run_all(
        &db,
        &format!("CREATE TABLE things (id int); ALTER TABLE things OWNER TO \"{owner}\""),
        &[],
    )
    .await
    .unwrap();

    let refused = run(
        &db,
        &RoleOperation::Drop(DropRole {
            name: owner.clone(),
            reassign_to: None,
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.pg_code(), Some("2BP01"), "{refused:?}");
    assert!(find(&dev, &owner).await.is_some());

    run(
        &db,
        &RoleOperation::Drop(DropRole {
            name: owner.clone(),
            reassign_to: Some(heir.clone()),
        }),
    )
    .await
    .unwrap();
    assert!(find(&dev, &owner).await.is_none());
    let who: String = db
        .meta()
        .await
        .unwrap()
        .query_one(
            "SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE relname = 'things'",
            &[],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(who, heir);

    db.close().await;
    scratch.drop_it(&dev).await;
    forget(&dev, &[&heir]).await;
}

fn target(kind: PrivilegeTargetKind, schema: &str, name: &str) -> PrivilegeTarget {
    PrivilegeTarget {
        kind,
        schema: schema.into(),
        name: name.into(),
    }
}

fn change(
    t: &PrivilegeTarget,
    grantee: Option<&str>,
    privilege: &str,
    grant: bool,
) -> PrivilegeChange {
    PrivilegeChange {
        target: t.clone(),
        grantee: grantee.map(str::to_owned),
        privilege: privilege.into(),
        grant,
    }
}

#[tokio::test]
async fn the_privilege_matrix_reads_grants_and_revokes() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let reader = role_name("reader");
    forget(&dev, &[&reader]).await;
    run(&dev, &create_role(&reader, None, &[])).await.unwrap();
    let scratch = Scratch::create(&dev, "privileges").await;
    let db = scratch.open().await;
    run_all(
        &db,
        "CREATE TABLE orders (id int); CREATE VIEW order_ids AS SELECT id FROM orders;
         CREATE SEQUENCE order_seq",
        &[],
    )
    .await
    .unwrap();
    let client = db.meta().await.unwrap();

    let table = target(PrivilegeTargetKind::Relation, "public", "orders");
    let before = matrix(&client, &table).await.unwrap();
    assert_eq!(before.owner, "angkor");
    assert_eq!(
        before.privileges,
        [
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "TRUNCATE",
            "REFERENCES",
            "TRIGGER"
        ]
    );
    assert_eq!(before.rows[0].grantee, None); // PUBLIC first
    assert!(before.rows[0].granted.is_empty());
    let owner = before.rows.iter().find(|r| r.owner).unwrap();
    assert_eq!(owner.grantee.as_deref(), Some("angkor"));
    assert_eq!(owner.granted.len(), 7);
    assert!(owner.superuser);
    let reader_row = before
        .rows
        .iter()
        .find(|r| r.grantee.as_deref() == Some(reader.as_str()))
        .unwrap();
    assert!(reader_row.granted.is_empty() && !reader_row.owner);
    // Roles that ship with PostgreSQL are not rows.
    assert!(
        before
            .rows
            .iter()
            .all(|r| !r.grantee.as_deref().is_some_and(|g| g.starts_with("pg_")))
    );

    let grants = [
        change(&table, Some(&reader), "UPDATE", true),
        change(&table, Some(&reader), "SELECT", true),
        change(&table, None, "SELECT", true),
    ];
    assert_eq!(apply_privileges(&client, &grants).await.unwrap(), 2);
    let after = matrix(&client, &table).await.unwrap();
    let reader_row = after
        .rows
        .iter()
        .find(|r| r.grantee.as_deref() == Some(reader.as_str()))
        .unwrap();
    assert_eq!(reader_row.granted, ["SELECT", "UPDATE"]);
    assert_eq!(after.rows[0].granted, ["SELECT"]);

    // Taking one back, including from the owner.
    apply_privileges(
        &client,
        &[
            change(&table, Some(&reader), "UPDATE", false),
            change(&table, Some("angkor"), "TRUNCATE", false),
        ],
    )
    .await
    .unwrap();
    let revoked = matrix(&client, &table).await.unwrap();
    let reader_row = revoked
        .rows
        .iter()
        .find(|r| r.grantee.as_deref() == Some(reader.as_str()))
        .unwrap();
    assert_eq!(reader_row.granted, ["SELECT"]);
    assert!(
        !revoked
            .rows
            .iter()
            .find(|r| r.owner)
            .unwrap()
            .granted
            .contains(&"TRUNCATE".to_owned())
    );

    // A view takes the table privileges; a sequence and a schema have their own.
    let view = target(PrivilegeTargetKind::Relation, "public", "order_ids");
    assert_eq!(matrix(&client, &view).await.unwrap().privileges.len(), 7);
    let seq = target(PrivilegeTargetKind::Sequence, "public", "order_seq");
    apply_privileges(&client, &[change(&seq, Some(&reader), "USAGE", true)])
        .await
        .unwrap();
    let seq_matrix = matrix(&client, &seq).await.unwrap();
    assert_eq!(seq_matrix.privileges, ["USAGE", "SELECT", "UPDATE"]);
    assert_eq!(
        seq_matrix
            .rows
            .iter()
            .find(|r| r.grantee.as_deref() == Some(reader.as_str()))
            .unwrap()
            .granted,
        ["USAGE"]
    );
    let schema = target(PrivilegeTargetKind::Schema, "", "public");
    let schema_matrix = matrix(&client, &schema).await.unwrap();
    assert_eq!(schema_matrix.privileges, ["USAGE", "CREATE"]);
    assert_eq!(schema_matrix.rows[0].granted, ["USAGE"]); // PUBLIC may use the public schema
    apply_privileges(&client, &[change(&schema, Some(&reader), "CREATE", true)])
        .await
        .unwrap();

    // Not there, or not that kind of thing.
    let missing = target(PrivilegeTargetKind::Relation, "public", "nope");
    assert!(matches!(
        matrix(&client, &missing).await,
        Err(AppError::NotFound(_))
    ));
    let wrong = target(PrivilegeTargetKind::Sequence, "public", "orders");
    assert!(matches!(
        matrix(&client, &wrong).await,
        Err(AppError::NotFound(_))
    ));

    // Nothing was applied half way: a bad statement rolls the whole batch back.
    let error = apply_privileges(
        &client,
        &[
            change(&table, Some(&reader), "DELETE", true),
            change(&table, Some("angkordb_no_such_role"), "DELETE", true),
        ],
    )
    .await
    .unwrap_err();
    assert!(matches!(error, AppError::Postgres { .. }), "{error:?}");
    let still = matrix(&client, &table).await.unwrap();
    assert!(
        !still
            .rows
            .iter()
            .find(|r| r.grantee.as_deref() == Some(reader.as_str()))
            .unwrap()
            .granted
            .contains(&"DELETE".to_owned())
    );
    drop(client);

    db.close().await;
    scratch.drop_it(&dev).await;
    forget(&dev, &[&reader]).await;
}

#[tokio::test]
async fn default_privileges_are_listed_per_role_schema_and_kind() {
    let Some(dev) = open_or_skip().await else {
        return;
    };
    let reader = role_name("defaults");
    forget(&dev, &[&reader]).await;
    run(&dev, &create_role(&reader, None, &[])).await.unwrap();
    let scratch = Scratch::create(&dev, "defaults").await;
    let db = scratch.open().await;
    run_all(
        &db,
        &format!(
            "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO \"{reader}\";
             ALTER DEFAULT PRIVILEGES GRANT USAGE ON SEQUENCES TO PUBLIC"
        ),
        &[],
    )
    .await
    .unwrap();
    let client = db.meta().await.unwrap();
    let found = defaults(&client).await.unwrap();
    let tables = found
        .iter()
        .find(|d| d.object_type == "tables" && d.grantee.as_deref() == Some(reader.as_str()))
        .unwrap();
    assert_eq!(tables.role, "angkor");
    assert_eq!(tables.schema.as_deref(), Some("public"));
    assert_eq!(tables.privileges, ["INSERT", "SELECT"]);
    let sequences = found
        .iter()
        .find(|d| d.object_type == "sequences" && d.grantee.is_none())
        .unwrap();
    assert_eq!(sequences.schema, None);
    assert!(sequences.privileges.contains(&"USAGE".to_owned()));
    drop(client);

    db.close().await;
    scratch.drop_it(&dev).await;
    forget(&dev, &[&reader]).await;
}

#[test]
fn the_preview_never_contains_the_password_or_its_verifier() {
    let secret = "hunter2-hunter2";
    let shown = preview(&create_role("someone", Some(secret), &[])).unwrap();
    assert!(!shown.sql.contains(secret) && !shown.sql.contains("SCRAM"));
    assert!(
        shown
            .statements
            .iter()
            .all(|s| !s.sql.contains(secret) && !s.sql.contains("SCRAM"))
    );
    let _ = DEV_PASSWORD;
}
