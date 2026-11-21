//! Who may do what to a schema, table or sequence (ANG-42): read from the ACLs, changed with
//! `GRANT` and `REVOKE`.

use std::collections::{BTreeSet, HashMap};

use tokio_postgres::Client;

use crate::db::alter::LOCK_TIMEOUT_MS;
use crate::db::rows::quote_ident;
use crate::error::{AppError, AppResult};
use crate::models::alter::{PlannedStatement, StructurePreview};
use crate::models::privileges::{
    DefaultPrivilege, PrivilegeChange, PrivilegeMatrix, PrivilegeRow, PrivilegeTarget,
    PrivilegeTargetKind,
};

const RELATION: [&str; 7] = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
];
const SEQUENCE: [&str; 3] = ["USAGE", "SELECT", "UPDATE"];
const SCHEMA: [&str; 2] = ["USAGE", "CREATE"];

fn invalid(message: impl Into<String>) -> AppError {
    AppError::Validation(message.into())
}

/// The columns of the matrix for this kind of object.
pub fn privileges_of(kind: PrivilegeTargetKind) -> &'static [&'static str] {
    match kind {
        PrivilegeTargetKind::Schema => &SCHEMA,
        PrivilegeTargetKind::Relation => &RELATION,
        PrivilegeTargetKind::Sequence => &SEQUENCE,
    }
}

fn target_sql(target: &PrivilegeTarget) -> AppResult<String> {
    if target.name.trim().is_empty() {
        return Err(invalid("Which object?"));
    }
    Ok(match target.kind {
        PrivilegeTargetKind::Schema => format!("SCHEMA {}", quote_ident(&target.name)),
        PrivilegeTargetKind::Relation | PrivilegeTargetKind::Sequence => {
            if target.schema.trim().is_empty() {
                return Err(invalid("Which schema?"));
            }
            let word = if target.kind == PrivilegeTargetKind::Sequence {
                "SEQUENCE"
            } else {
                "TABLE"
            };
            format!(
                "{word} {}.{}",
                quote_ident(&target.schema),
                quote_ident(&target.name)
            )
        }
    })
}

fn grantee_sql(grantee: Option<&str>) -> AppResult<String> {
    match grantee {
        None => Ok("PUBLIC".into()),
        Some(g) if g.trim().is_empty() => Err(invalid("Which role?")),
        Some(g) => Ok(quote_ident(g)),
    }
}

/// `GRANT SELECT, INSERT ON TABLE … TO …;` — the changes for one object and role that go the
/// same way share a statement.
pub fn plan(changes: &[PrivilegeChange]) -> AppResult<Vec<PlannedStatement>> {
    // Keep the order the changes were made in, one statement per (object, role, direction).
    let mut groups: Vec<(String, String, bool, BTreeSet<&'static str>)> = Vec::new();
    for change in changes {
        let wanted = change.privilege.trim().to_ascii_uppercase();
        let Some(privilege) = privileges_of(change.target.kind)
            .iter()
            .find(|p| **p == wanted)
        else {
            return Err(invalid(format!(
                "{} is not a privilege of a {}.",
                change.privilege,
                match change.target.kind {
                    PrivilegeTargetKind::Schema => "schema",
                    PrivilegeTargetKind::Relation => "table",
                    PrivilegeTargetKind::Sequence => "sequence",
                }
            )));
        };
        let object = target_sql(&change.target)?;
        let grantee = grantee_sql(change.grantee.as_deref())?;
        match groups
            .iter_mut()
            .find(|g| g.0 == object && g.1 == grantee && g.2 == change.grant)
        {
            Some(group) => {
                group.3.insert(privilege);
            }
            None => groups.push((object, grantee, change.grant, BTreeSet::from([*privilege]))),
        }
    }
    Ok(groups
        .into_iter()
        .map(|(object, grantee, grant, set)| {
            // The order PostgreSQL itself lists them in, not alphabetical.
            let kind_order = |p: &&str| {
                RELATION
                    .iter()
                    .chain(SEQUENCE.iter())
                    .chain(SCHEMA.iter())
                    .position(|q| q == p)
                    .unwrap_or(usize::MAX)
            };
            let mut list: Vec<&str> = set.into_iter().collect();
            list.sort_by_key(kind_order);
            let (verb, link) = if grant {
                ("GRANT", "TO")
            } else {
                ("REVOKE", "FROM")
            };
            PlannedStatement {
                sql: format!("{verb} {} ON {object} {link} {grantee};", list.join(", ")),
                label: format!("{} {} on {object}", verb.to_lowercase(), list.join(", ")),
                change: 1,
                concurrent: false,
                destructive: false,
            }
        })
        .collect())
}

pub fn preview(changes: &[PrivilegeChange]) -> AppResult<StructurePreview> {
    let statements = plan(changes)?;
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

/// Run the changes in one transaction. Returns how many statements ran.
pub async fn apply(client: &Client, changes: &[PrivilegeChange]) -> AppResult<u32> {
    let statements = plan(changes)?;
    if statements.is_empty() {
        return Ok(0);
    }
    client
        .batch_execute(&format!(
            "BEGIN; SET LOCAL lock_timeout = {LOCK_TIMEOUT_MS}"
        ))
        .await?;
    for statement in &statements {
        if let Err(e) = client.batch_execute(&statement.sql).await {
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

/// Who holds which privileges on one object.
pub async fn matrix(client: &Client, target: &PrivilegeTarget) -> AppResult<PrivilegeMatrix> {
    let columns = privileges_of(target.kind);
    let (owner_sql, acl_sql, params): (
        &str,
        &str,
        Vec<&(dyn tokio_postgres::types::ToSql + Sync)>,
    ) = match target.kind {
        PrivilegeTargetKind::Schema => (
            "SELECT o.rolname::text FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
                  WHERE n.nspname = $1",
            "SELECT a.grantee, a.privilege_type::text, a.is_grantable
                   FROM pg_namespace n
                  CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) a
                  WHERE n.nspname = $1",
            vec![&target.name],
        ),
        PrivilegeTargetKind::Relation | PrivilegeTargetKind::Sequence => {
            let sequence = target.kind == PrivilegeTargetKind::Sequence;
            (
                    if sequence {
                        "SELECT o.rolname::text FROM pg_class c
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                           JOIN pg_roles o ON o.oid = c.relowner
                          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'S'"
                    } else {
                        "SELECT o.rolname::text FROM pg_class c
                           JOIN pg_namespace n ON n.oid = c.relnamespace
                           JOIN pg_roles o ON o.oid = c.relowner
                          WHERE n.nspname = $1 AND c.relname = $2
                            AND c.relkind IN ('r', 'v', 'm', 'f', 'p')"
                    },
                    "SELECT a.grantee, a.privilege_type::text, a.is_grantable
                       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,
                            acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::\"char\", c.relowner))) a
                      WHERE n.nspname = $1 AND c.relname = $2",
                    vec![&target.schema, &target.name],
                )
        }
    };

    let owner: String = client
        .query_opt(owner_sql, &params)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("{}.{}", target.schema, target.name)))?
        .get(0);
    let acl = client.query(acl_sql, &params).await?;
    let roles = client
        .query(
            "SELECT oid, rolname::text, rolsuper FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname",
            &[],
        )
        .await?;

    // grantee oid (0 = PUBLIC) → what it holds
    let mut held: HashMap<u32, (BTreeSet<String>, BTreeSet<String>)> = HashMap::new();
    for row in &acl {
        let grantee: u32 = row.get(0);
        let privilege: String = row.get(1);
        let grantable: bool = row.get(2);
        let entry = held.entry(grantee).or_default();
        entry.0.insert(privilege.clone());
        if grantable {
            entry.1.insert(privilege);
        }
    }
    let in_order = |set: &BTreeSet<String>| {
        columns
            .iter()
            .filter(|c| set.contains(**c))
            .map(|c| (*c).to_owned())
            .collect::<Vec<_>>()
    };

    let mut rows = vec![{
        let (granted, grantable) = held.remove(&0).unwrap_or_default();
        PrivilegeRow {
            grantee: None,
            superuser: false,
            owner: false,
            granted: in_order(&granted),
            grantable: in_order(&grantable),
        }
    }];
    for role in &roles {
        let oid: u32 = role.get(0);
        let name: String = role.get(1);
        let (granted, grantable) = held.remove(&oid).unwrap_or_default();
        rows.push(PrivilegeRow {
            owner: name == owner,
            superuser: role.get(2),
            granted: in_order(&granted),
            grantable: in_order(&grantable),
            grantee: Some(name),
        });
    }
    Ok(PrivilegeMatrix {
        privileges: columns.iter().map(|c| (*c).to_owned()).collect(),
        owner,
        rows,
    })
}

/// What new objects start out with (`ALTER DEFAULT PRIVILEGES`), in this database.
pub async fn defaults(client: &Client) -> AppResult<Vec<DefaultPrivilege>> {
    let rows = client
        .query(
            "SELECT r.rolname::text, n.nspname::text, d.defaclobjtype::text, a.grantee,
                    array_agg(a.privilege_type::text ORDER BY a.privilege_type)
               FROM pg_default_acl d
               JOIN pg_roles r ON r.oid = d.defaclrole
               LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
              CROSS JOIN LATERAL aclexplode(d.defaclacl) a
              GROUP BY 1, 2, 3, 4
              ORDER BY 1, 2 NULLS FIRST, 3, 4",
            &[],
        )
        .await?;
    let names: HashMap<u32, String> = client
        .query("SELECT oid, rolname::text FROM pg_roles", &[])
        .await?
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    Ok(rows
        .iter()
        .map(|row| {
            let kind: String = row.get(2);
            let grantee: u32 = row.get(3);
            DefaultPrivilege {
                role: row.get(0),
                schema: row.get(1),
                object_type: match kind.as_str() {
                    "r" => "tables",
                    "S" => "sequences",
                    "f" => "functions",
                    "T" => "types",
                    "n" => "schemas",
                    other => other,
                }
                .to_owned(),
                grantee: (grantee != 0).then(|| names.get(&grantee).cloned().unwrap_or_default()),
                privileges: row.get(4),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table(name: &str) -> PrivilegeTarget {
        PrivilegeTarget {
            kind: PrivilegeTargetKind::Relation,
            schema: "public".into(),
            name: name.into(),
        }
    }

    fn change(
        target: &PrivilegeTarget,
        grantee: Option<&str>,
        privilege: &str,
        grant: bool,
    ) -> PrivilegeChange {
        PrivilegeChange {
            target: target.clone(),
            grantee: grantee.map(str::to_owned),
            privilege: privilege.into(),
            grant,
        }
    }

    #[test]
    fn changes_for_one_role_share_a_statement_in_postgres_order() {
        let t = table("orders");
        let sql: Vec<String> = plan(&[
            change(&t, Some("bob"), "update", true),
            change(&t, Some("bob"), "SELECT", true),
            change(&t, Some("bob"), "delete", false),
            change(&t, None, "select", true),
            change(&t, Some("bob"), "SELECT", true),
        ])
        .unwrap()
        .into_iter()
        .map(|s| s.sql)
        .collect();
        assert_eq!(
            sql,
            [
                "GRANT SELECT, UPDATE ON TABLE \"public\".\"orders\" TO \"bob\";",
                "REVOKE DELETE ON TABLE \"public\".\"orders\" FROM \"bob\";",
                "GRANT SELECT ON TABLE \"public\".\"orders\" TO PUBLIC;",
            ]
        );
    }

    #[test]
    fn schemas_and_sequences_have_their_own_privileges_and_keywords() {
        let schema = PrivilegeTarget {
            kind: PrivilegeTargetKind::Schema,
            schema: String::new(),
            name: "billing".into(),
        };
        let sequence = PrivilegeTarget {
            kind: PrivilegeTargetKind::Sequence,
            schema: "public".into(),
            name: "orders_id_seq".into(),
        };
        let sql: Vec<String> = plan(&[
            change(&schema, Some("bob"), "CREATE", true),
            change(&schema, Some("bob"), "USAGE", true),
            change(&sequence, Some("bob"), "USAGE", true),
        ])
        .unwrap()
        .into_iter()
        .map(|s| s.sql)
        .collect();
        assert_eq!(
            sql[0],
            "GRANT USAGE, CREATE ON SCHEMA \"billing\" TO \"bob\";"
        );
        assert_eq!(
            sql[1],
            "GRANT USAGE ON SEQUENCE \"public\".\"orders_id_seq\" TO \"bob\";"
        );
    }

    #[test]
    fn a_privilege_the_object_does_not_have_is_refused() {
        let t = table("orders");
        assert!(plan(&[change(&t, Some("bob"), "USAGE", true)]).is_err());
        assert!(plan(&[change(&t, Some("bob"), "SELECT; DROP TABLE x", true)]).is_err());
        assert!(plan(&[change(&t, Some(""), "SELECT", true)]).is_err());
        assert!(plan(&[change(&table(" "), Some("bob"), "SELECT", true)]).is_err());
    }

    #[test]
    fn names_are_quoted() {
        let t = table("we\"ird");
        let sql = plan(&[change(&t, Some("r\"x"), "SELECT", true)]).unwrap()[0]
            .sql
            .clone();
        assert_eq!(
            sql,
            "GRANT SELECT ON TABLE \"public\".\"we\"\"ird\" TO \"r\"\"x\";"
        );
    }
}
