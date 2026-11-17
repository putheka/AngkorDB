use serde::Serialize;
use tauri::AppHandle;

use crate::error::AppResult;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
}

/// Smoke-test command: proves the React ⇄ Rust bridge works.
#[tauri::command]
pub fn app_info(app: AppHandle) -> AppResult<AppInfo> {
    let pkg = app.package_info();
    Ok(AppInfo {
        name: pkg.name.clone(),
        version: pkg.version.to_string(),
    })
}
