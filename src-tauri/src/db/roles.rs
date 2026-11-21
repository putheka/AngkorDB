//! Listing, creating, altering and dropping roles (ANG-42).
//!
//! A password never reaches the server as typed: it is turned into a SCRAM-SHA-256 verifier here
//! and that is what `PASSWORD '…'` carries, so neither `log_statement` nor `pg_stat_activity` can
//! show it. The preview shows `'••••••••'` in its place; neither the password nor its verifier is
//! kept in the app's history or logs (role changes don't go through the query history at all).

use std::collections::HashMap;

use postgres_protocol::password::scram_sha_256;
use tokio_postgres::Client;

use crate::db::alter::LOCK_TIMEOUT_MS;
use crate::db::rows::quote_ident;
use crate::db::structure::literal;
use crate::error::{AppError, AppResult};
use crate::models::alter::{PlannedStatement, StructurePreview};
use crate::models::roles::{
    AlterRole, CreateRole, DropRole, Role, RoleAttributes, RoleOperation, RolePasswordChange,
};

/// What shows where the password goes.
const MASK: &str = "'••••••••'";

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// A statement as it runs, and as the preview shows it (they differ only in the password).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleStatement {
    pub run: String,
    pub shown: String,
    pub label: String,
    pub destructive: bool,
}

fn plain(label: impl Into<String>, sql: String, destructive: bool) -> RoleStatement {
    RoleStatement {
        run: sql.clone(),
        shown: sql,
        label: label.into(),
        destructive,
    }
}

fn name(text: &str, what: &str) -> AppResult<String> {
    if text.trim().is_empty() {
        return Err(invalid(format!("Give the {what} a name.")));
    }
    Ok(quote_ident(text))
}

fn on_off(on: bool, yes: &str, no: &str) -> String {
    (if on { yes } else { no }).to_owned()
}

/// `LOGIN NOSUPERUSER …`: every attribute, so the role ends up exactly as the form says.
/// `valid_until` is left out when there is none and `explicit_never` is false (a new role).
fn attributes(a: &RoleAttributes, explicit_never: bool) -> AppResult<String> {
    let mut words = vec![
        on_off(a.can_login, "LOGIN", "NOLOGIN"),
        on_off(a.superuser, "SUPERUSER", "NOSUPERUSER"),
        on_off(a.create_db, "CREATEDB", "NOCREATEDB"),
        on_off(a.create_role, "CREATEROLE", "NOCREATEROLE"),
        on_off(a.inherit, "INHERIT", "NOINHERIT"),
        on_off(a.replication, "REPLICATION", "NOREPLICATION"),
        on_off(a.bypass_rls, "BYPASSRLS", "NOBYPASSRLS"),
    ];
    match a.connection_limit {
        Some(n) if n < 0 => return Err(invalid("The connection limit can't be negative.")),
        Some(n) => words.push(format!("CONNECTION LIMIT {n}")),
        None => words.push("CONNECTION LIMIT -1".into()),
    }
    match a
        .valid_until
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        Some(when) => words.push(format!("VALID UNTIL {}", literal(when))),
        None if explicit_never => words.push("VALID UNTIL 'infinity'".into()),
        None => {}
    }
    Ok(words.join(" "))
}

/// `PASSWORD '<verifier>'` for running and `PASSWORD '••••••••'` for showing.
fn password(plain_text: &str) -> AppResult<(String, String)> {
    if plain_text.is_empty() {
        return Err(invalid("The password is empty."));
    }
    let verifier = scram_sha_256(plain_text.as_bytes());
    Ok((
        format!("PASSWORD {}", literal(&verifier)),
        format!("PASSWORD {MASK}"),
    ))
}

fn create(c: &CreateRole, out: &mut Vec<RoleStatement>) -> AppResult<()> {
    let role = name(&c.name, "role")?;
    let mut run = format!(
        "CREATE ROLE {role} WITH {}",
        attributes(&c.attributes, false)?
    );
    let mut shown = run.clone();
    if let Some(secret) = c.password.as_deref() {
        let (real, masked) = password(secret)?;
        run = format!("{run} {real}");
        shown = format!("{shown} {masked}");
    }
    out.push(RoleStatement {
        run: format!("{run};"),
        shown: format!("{shown};"),
        label: format!("create role {}", c.name),
        destructive: false,
    });
    for group in &c.member_of {
        out.push(plain(
            format!("make {} a member of {group}", c.name),
            format!("GRANT {} TO {role};", name(group, "role")?),
            false,
        ));
    }
    Ok(())
}

fn alter(a: &AlterRole, out: &mut Vec<RoleStatement>) -> AppResult<()> {
    let mut current = name(&a.name, "role")?;
    let mut current_name = a.name.as_str();
    if let Some(new_name) = a.new_name.as_deref().filter(|n| *n != a.name) {
        let renamed = name(new_name, "role")?;
        out.push(plain(
            format!("rename role {} to {new_name}", a.name),
            format!("ALTER ROLE {current} RENAME TO {renamed};"),
            false,
        ));
        current = renamed;
        current_name = new_name;
    }

    let mut run = format!(
        "ALTER ROLE {current} WITH {}",
        attributes(&a.attributes, true)?
    );
    let mut shown = run.clone();
    match &a.password {
        RolePasswordChange::Keep => {}
        RolePasswordChange::Set { value } => {
            let (real, masked) = password(value)?;
            run = format!("{run} {real}");
            shown = format!("{shown} {masked}");
        }
        RolePasswordChange::Clear => {
            run.push_str(" PASSWORD NULL");
            shown.push_str(" PASSWORD NULL");
        }
    }
    out.push(RoleStatement {
        run: format!("{run};"),
        shown: format!("{shown};"),
        label: format!("alter role {current_name}"),
        destructive: false,
    });

    for group in a
        .member_of
        .iter()
        .filter(|g| !a.previous_member_of.contains(g))
    {
        out.push(plain(
            format!("make {current_name} a member of {group}"),
            format!("GRANT {} TO {current};", name(group, "role")?),
            false,
        ));
    }
    for group in a
        .previous_member_of
        .iter()
        .filter(|g| !a.member_of.contains(g))
    {
        out.push(plain(
            format!("remove {current_name} from {group}"),
            format!("REVOKE {} FROM {current};", name(group, "role")?),
            true,
        ));
    }
    Ok(())
}

fn drop_role(d: &DropRole, out: &mut Vec<RoleStatement>) -> AppResult<()> {
    let role = name(&d.name, "role")?;
    if let Some(heir) = d.reassign_to.as_deref().filter(|h| !h.trim().is_empty()) {
        if heir == d.name {
            return Err(invalid("A role can't hand what it owns to itself."));
        }
        out.push(plain(
            format!("give what {} owns to {heir}", d.name),
            format!("REASSIGN OWNED BY {role} TO {};", name(heir, "role")?),
            true,
        ));
        out.push(plain(
            format!("drop what {} still has", d.name),
            format!("DROP OWNED BY {role};"),
            true,
        ));
    }
    out.push(plain(
        format!("drop role {}", d.name),
        format!("DROP ROLE {role};"),
        true,
    ));
    Ok(())
}

pub fn plan(operation: &RoleOperation) -> AppResult<Vec<RoleStatement>> {
    let mut out = Vec::new();
    match operation {
        RoleOperation::Create(c) => create(c, &mut out)?,
        RoleOperation::Alter(a) => alter(a, &mut out)?,
        RoleOperation::Drop(d) => drop_role(d, &mut out)?,
    }
    Ok(out)
}

/// What the operation would run, for the preview: with the password hidden.
pub fn preview(operation: &RoleOperation) -> AppResult<StructurePreview> {
    let statements: Vec<PlannedStatement> = plan(operation)?
        .into_iter()
        .map(|s| PlannedStatement {
            sql: s.shown,
            label: s.label,
            change: 1,
            concurrent: false,
            destructive: s.destructive,
        })
        .collect();
    let sql = format!(
        "-- In one transaction: all or nothing.\n{}",
        statements
            .iter()
            .map(|s| s.sql.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok(StructurePreview { statements, sql })
}

/// Run the operation in one transaction. Returns how many statements ran.
pub async fn apply(client: &Client, operation: &RoleOperation) -> AppResult<u32> {
    let statements = plan(operation)?;
    client
        .batch_execute(&format!(
            "BEGIN; SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"
        ))
        .await?;
    for statement in &statements {
        if let Err(e) = client.batch_execute(&statement.run).await {
            let _ = client.batch_execute("ROLLBACK").await;
            return Err(e.into());
        }
    }
    if let Err(e) = client.batch_execute("COMMIT").await {
        let _ = client.batch_execute("ROLLBACK").await;
        return Err(e.into());
    }
    Ok(u32::try_from(statements.len()).unwrap_or(u32::MAX))
}

/// Every role of the server, with what each is a member of.
pub async fn list(client: &Client) -> AppResult<Vec<Role>> {
    let rows = client
        .query(
            "SELECT r.oid, r.rolname::text, r.rolcanlogin, r.rolsuper, r.rolcreatedb,
                    r.rolcreaterole, r.rolinherit, r.rolreplication, r.rolbypassrls,
                    r.rolconnlimit, r.rolvaliduntil::text, r.rolname = current_user
               FROM pg_roles r
              ORDER BY r.rolname",
            &[],
        )
        .await?;
    let memberships = client
        .query(
            "SELECT m.member, g.rolname::text
               FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
              ORDER BY g.rolname",
            &[],
        )
        .await?;
    let mut groups: HashMap<u32, Vec<String>> = HashMap::new();
    for row in &memberships {
        groups.entry(row.get(0)).or_default().push(row.get(1));
    }
    Ok(rows
        .iter()
        .map(|row| {
            let oid: u32 = row.get(0);
            let name: String = row.get(1);
            let limit: i32 = row.get(9);
            let until: Option<String> = row.get(10);
            Role {
                predefined: name.starts_with("pg_"),
                name,
                can_login: row.get(2),
                superuser: row.get(3),
                create_db: row.get(4),
                create_role: row.get(5),
                inherit: row.get(6),
                replication: row.get(7),
                bypass_rls: row.get(8),
                connection_limit: (limit >= 0).then_some(limit),
                valid_until: until.filter(|u| u != "infinity"),
                member_of: groups.remove(&oid).unwrap_or_default(),
                is_current: row.get(11),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn create_op(secret: Option<&str>) -> RoleOperation {
        RoleOperation::Create(CreateRole {
            name: "report\"er".into(),
            attributes: attrs(),
            password: secret.map(str::to_owned),
            member_of: vec!["readers".into()],
        })
    }

    #[test]
    fn a_new_role_is_written_in_full_with_its_memberships() {
        let plan = plan(&create_op(None)).unwrap();
        assert_eq!(
            plan[0].run,
            "CREATE ROLE \"report\"\"er\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE \
             INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;"
        );
        assert_eq!(plan[1].run, "GRANT \"readers\" TO \"report\"\"er\";");
    }

    #[test]
    fn the_password_is_sent_as_a_verifier_and_shown_as_dots() {
        let secret = "correct horse'battery\\staple";
        let plan = plan(&create_op(Some(secret))).unwrap();
        assert!(
            plan[0].run.contains("PASSWORD 'SCRAM-SHA-256$4096:"),
            "{}",
            plan[0].run
        );
        assert!(!plan[0].run.contains(secret));
        assert!(plan[0].shown.contains(&format!("PASSWORD {MASK}")));
        assert!(!plan[0].shown.contains("SCRAM"));
        assert!(!plan[0].shown.contains(secret));

        let shown = preview(&create_op(Some(secret))).unwrap();
        assert!(!shown.sql.contains(secret) && !shown.sql.contains("SCRAM"));
        assert!(shown.sql.contains(MASK));
        // Another run gives another salt.
        let again = super::plan(&create_op(Some(secret))).unwrap();
        assert_ne!(again[0].run, plan[0].run);
    }

    #[test]
    fn an_empty_password_and_a_negative_limit_are_refused() {
        assert!(plan(&create_op(Some(""))).is_err());
        let mut op = create_op(None);
        if let RoleOperation::Create(c) = &mut op {
            c.attributes.connection_limit = Some(-5);
        }
        assert!(plan(&op).is_err());
    }

    #[test]
    fn altering_renames_first_then_sets_everything_and_diffs_the_memberships() {
        let op = RoleOperation::Alter(AlterRole {
            name: "old".into(),
            new_name: Some("new".into()),
            attributes: RoleAttributes {
                connection_limit: Some(5),
                valid_until: Some("2030-01-01".into()),
                ..attrs()
            },
            password: RolePasswordChange::Clear,
            member_of: vec!["a".into(), "b".into()],
            previous_member_of: vec!["b".into(), "c".into()],
        });
        let sql: Vec<String> = plan(&op).unwrap().into_iter().map(|s| s.run).collect();
        assert_eq!(sql[0], "ALTER ROLE \"old\" RENAME TO \"new\";");
        assert_eq!(
            sql[1],
            "ALTER ROLE \"new\" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT \
             NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 VALID UNTIL '2030-01-01' PASSWORD NULL;"
        );
        assert_eq!(sql[2], "GRANT \"a\" TO \"new\";");
        assert_eq!(sql[3], "REVOKE \"c\" FROM \"new\";");
        assert_eq!(sql.len(), 4);
    }

    #[test]
    fn altering_without_an_expiry_says_never_and_keeps_the_password() {
        let op = RoleOperation::Alter(AlterRole {
            name: "r".into(),
            new_name: None,
            attributes: attrs(),
            password: RolePasswordChange::Keep,
            member_of: vec![],
            previous_member_of: vec![],
        });
        let plan = plan(&op).unwrap();
        assert_eq!(plan.len(), 1);
        assert!(plan[0].run.contains("VALID UNTIL 'infinity'"));
        assert!(!plan[0].run.contains("PASSWORD"));
    }

    #[test]
    fn dropping_can_hand_over_what_the_role_owns() {
        let op = RoleOperation::Drop(DropRole {
            name: "gone".into(),
            reassign_to: Some("heir".into()),
        });
        let sql: Vec<String> = plan(&op).unwrap().into_iter().map(|s| s.run).collect();
        assert_eq!(
            sql,
            [
                "REASSIGN OWNED BY \"gone\" TO \"heir\";",
                "DROP OWNED BY \"gone\";",
                "DROP ROLE \"gone\";"
            ]
        );
        let itself = RoleOperation::Drop(DropRole {
            name: "x".into(),
            reassign_to: Some("x".into()),
        });
        assert!(plan(&itself).is_err());
        assert!(
            plan(&RoleOperation::Drop(DropRole {
                name: " ".into(),
                reassign_to: None
            }))
            .is_err()
        );
    }
}
