//! Put the version (from `tauri.conf.json`, the one place it is written down) and the git commit
//! the build was made from into the program, for the About window and the status bar.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

fn main() {
    let config = std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json");
    let config: serde_json::Value = serde_json::from_str(&config).expect("tauri.conf.json is JSON");
    let version = config["version"]
        .as_str()
        .expect("a version in tauri.conf.json");
    println!("cargo:rustc-env=ANGKORDB_VERSION={version}");

    // The short commit, marked when the working tree has changes the commit doesn't.
    let commit = git(&["rev-parse", "--short", "HEAD"]).unwrap_or_else(|| "unknown".to_owned());
    let dirty = git(&["status", "--porcelain"]).is_some_and(|changes| !changes.is_empty());
    println!(
        "cargo:rustc-env=ANGKORDB_BUILD={commit}{}",
        if dirty { "-dirty" } else { "" }
    );
    // A new commit or a switched branch changes the build.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/refs");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build();
}
