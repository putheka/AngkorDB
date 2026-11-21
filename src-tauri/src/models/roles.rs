//! Roles: who exists, what they may do, and what changing them looks like (ANG-42).
//!
//! A password is typed once and never comes back: the app turns it into a SCRAM-SHA-256 verifier
//! before it is sent, so the server (and its log) never sees the password itself.

use serde::{Deserialize, Serialize};

/// One role of the server, from `pg_roles`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub name: String,
    pub can_login: bool,
    pub superuser: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub inherit: bool,
    pub replication: bool,
    pub bypass_rls: bool,
    /// `None`: no limit.
    pub connection_limit: Option<i32>,
    /// When the password stops working; `None` for never.
    pub valid_until: Option<String>,
    /// The roles this one is a member of.
    pub member_of: Vec<String>,
    /// A role PostgreSQL ships with (`pg_read_all_data`, …): it can't be changed or dropped.
    pub predefined: bool,
    /// The role the app is connected as.
    pub is_current: bool,
}

/// What a role may do. Written in full whenever a role is altered, so what the form shows is
/// what the role ends up with.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RoleAttributes {
    pub can_login: bool,
    pub superuser: bool,
    pub create_db: bool,
    pub create_role: bool,
    pub inherit: bool,
    pub replication: bool,
    pub bypass_rls: bool,
    pub connection_limit: Option<i32>,
    /// `2027-01-01` or a full timestamp; `None` for never.
    pub valid_until: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CreateRole {
    pub name: String,
    pub attributes: RoleAttributes,
    /// `None`: no password (the role can't log in with one).
    pub password: Option<String>,
    pub member_of: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RolePasswordChange {
    Keep,
    Set {
        value: String,
    },
    /// `PASSWORD NULL`
    Clear,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AlterRole {
    pub name: String,
    pub new_name: Option<String>,
    pub attributes: RoleAttributes,
    pub password: RolePasswordChange,
    /// What it should be a member of afterwards, and what it was before: the difference is
    /// granted and revoked.
    pub member_of: Vec<String>,
    pub previous_member_of: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DropRole {
    pub name: String,
    /// Give what the role owns to this role first (`REASSIGN OWNED`, then `DROP OWNED`: in this
    /// database only). Without it PostgreSQL refuses while the role owns anything.
    pub reassign_to: Option<String>,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RoleOperation {
    Create(CreateRole),
    Alter(AlterRole),
    Drop(DropRole),
}
