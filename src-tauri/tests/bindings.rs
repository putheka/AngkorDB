//! `src/bindings.ts` must match the Rust commands and types. This test fails when it's stale.
//! Regenerate with `npm run bindings` (sets `ANGKORDB_WRITE_BINDINGS=1`).

use std::fs;
use std::path::PathBuf;

use angkordb_lib::{BINDINGS_PATH, export_bindings};

#[test]
fn typescript_bindings_are_up_to_date() {
    let committed = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(BINDINGS_PATH);

    if std::env::var("ANGKORDB_WRITE_BINDINGS").is_ok_and(|v| v == "1") {
        export_bindings(&committed).expect("export bindings");
        return;
    }

    let fresh = std::env::temp_dir().join(format!("angkordb-bindings-{}.ts", std::process::id()));
    export_bindings(&fresh).expect("export bindings");
    let expected = fs::read_to_string(&fresh).expect("read fresh bindings");
    let _ = fs::remove_file(&fresh);

    let actual = fs::read_to_string(&committed).unwrap_or_default();
    assert!(
        actual == expected,
        "src/bindings.ts is out of date with the Rust commands. Run `npm run bindings`."
    );
}
