//! What the window looked like when the app was last used (ANG-50): the tabs, the text of the
//! query editors and how each table was sorted and filtered, one file per connection, and a small
//! file of what to do at launch. The page owns the shape of the workspace; this only keeps it as
//! text, written whole and in one step, so a force quit never leaves half a file.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::workspace::StartupState;

/// The biggest workspace that is kept (a few large scripts fit easily).
pub const MAX_WORKSPACE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StartupFile {
    restore_on_launch: bool,
    last_connection_id: Option<String>,
    /// Connections that were opened, the latest first (for the Dock menu).
    recent_connection_ids: Vec<String>,
}

impl Default for StartupFile {
    fn default() -> Self {
        Self {
            restore_on_launch: true,
            last_connection_id: None,
            recent_connection_ids: Vec::new(),
        }
    }
}

/// How many recently opened connections are remembered.
pub const MAX_RECENT_CONNECTIONS: usize = 8;

enum Place {
    Dir(PathBuf),
    Memory(Mutex<(HashMap<String, String>, StartupFile)>),
}

pub struct WorkspaceStore {
    place: Place,
    /// Saves and reads of the startup file are one at a time.
    lock: Mutex<()>,
}

/// A connection id is a UUID; anything else must never become part of a file name.
fn check_id(id: &str) -> AppResult<()> {
    let fine = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if fine {
        Ok(())
    } else {
        Err(AppError::Validation("That is not a connection id.".into()))
    }
}

fn storage(e: impl std::fmt::Display) -> AppError {
    AppError::Storage(e.to_string())
}

/// Write next to the file and move into place: either the old file or the whole new one is there.
fn write_atomically(path: &Path, text: &str) -> AppResult<()> {
    let part = path.with_extension("json.part");
    fs::write(&part, text)
        .and_then(|()| fs::rename(&part, path))
        .map_err(|e| {
            let _ = fs::remove_file(&part);
            storage(e)
        })
}

impl WorkspaceStore {
    /// Keep workspaces in files of this folder (made if missing).
    pub fn open(dir: &Path) -> AppResult<Self> {
        fs::create_dir_all(dir).map_err(storage)?;
        Ok(Self {
            place: Place::Dir(dir.to_path_buf()),
            lock: Mutex::new(()),
        })
    }

    /// Workspaces that last as long as the app runs (tests, or a folder that can't be written).
    pub fn in_memory() -> Self {
        Self {
            place: Place::Memory(Mutex::new((HashMap::new(), StartupFile::default()))),
            lock: Mutex::new(()),
        }
    }

    fn file(dir: &Path, id: &str) -> PathBuf {
        dir.join(format!("{id}.json"))
    }

    /// Keep the workspace of a connection. `data` must be JSON.
    pub fn save(&self, connection_id: &str, data: &str) -> AppResult<()> {
        check_id(connection_id)?;
        if data.len() > MAX_WORKSPACE_BYTES {
            return Err(AppError::Validation(
                "The workspace is too big to keep.".into(),
            ));
        }
        serde_json::from_str::<serde::de::IgnoredAny>(data)
            .map_err(|e| AppError::Validation(format!("The workspace is not JSON ({e}).")))?;
        match &self.place {
            Place::Dir(dir) => write_atomically(&Self::file(dir, connection_id), data),
            Place::Memory(memory) => {
                memory
                    .lock()
                    .map_err(storage)?
                    .0
                    .insert(connection_id.to_owned(), data.to_owned());
                Ok(())
            }
        }
    }

    /// The workspace last kept for a connection, if any (a file that can't be read is none).
    pub fn load(&self, connection_id: &str) -> AppResult<Option<String>> {
        check_id(connection_id)?;
        match &self.place {
            Place::Dir(dir) => match fs::read_to_string(Self::file(dir, connection_id)) {
                Ok(text) => Ok(Some(text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(storage(e)),
            },
            Place::Memory(memory) => Ok(memory
                .lock()
                .map_err(storage)?
                .0
                .get(connection_id)
                .cloned()),
        }
    }

    /// Forget the workspace of a connection (it was deleted).
    pub fn remove(&self, connection_id: &str) -> AppResult<()> {
        check_id(connection_id)?;
        match &self.place {
            Place::Dir(dir) => match fs::remove_file(Self::file(dir, connection_id)) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(storage(e)),
            },
            Place::Memory(memory) => {
                memory.lock().map_err(storage)?.0.remove(connection_id);
                Ok(())
            }
        }
    }

    fn read_startup(&self) -> StartupFile {
        match &self.place {
            Place::Dir(dir) => fs::read_to_string(dir.join("startup.json"))
                .ok()
                .and_then(|text| serde_json::from_str(&text).ok())
                .unwrap_or_default(),
            Place::Memory(memory) => memory.lock().map(|m| m.1.clone()).unwrap_or_default(),
        }
    }

    fn write_startup(&self, startup: &StartupFile) -> AppResult<()> {
        match &self.place {
            Place::Dir(dir) => {
                let text = serde_json::to_string_pretty(startup).map_err(storage)?;
                write_atomically(&dir.join("startup.json"), &text)
            }
            Place::Memory(memory) => {
                memory.lock().map_err(storage)?.1 = startup.clone();
                Ok(())
            }
        }
    }

    /// What to do at launch. A missing or damaged file means the defaults.
    pub fn startup(&self) -> StartupState {
        let _guard = self.lock.lock();
        let file = self.read_startup();
        StartupState {
            restore_on_launch: file.restore_on_launch,
            last_connection_id: file.last_connection_id,
        }
    }

    /// Reopen the last connection at launch (`true`, the default), or show the welcome screen.
    pub fn set_restore_on_launch(&self, restore: bool) -> AppResult<()> {
        let _guard = self.lock.lock();
        let mut file = self.read_startup();
        file.restore_on_launch = restore;
        self.write_startup(&file)
    }

    /// The connection that was open when the app was last used; `None` after a disconnect.
    pub fn set_last_connection(&self, connection_id: Option<&str>) -> AppResult<()> {
        if let Some(id) = connection_id {
            check_id(id)?;
        }
        let _guard = self.lock.lock();
        let mut file = self.read_startup();
        file.last_connection_id = connection_id.map(str::to_owned);
        if let Some(id) = connection_id {
            file.recent_connection_ids.retain(|recent| recent != id);
            file.recent_connection_ids.insert(0, id.to_owned());
            file.recent_connection_ids.truncate(MAX_RECENT_CONNECTIONS);
        }
        self.write_startup(&file)
    }

    /// The connections that were opened last, the latest first.
    pub fn recent_connections(&self) -> Vec<String> {
        let _guard = self.lock.lock();
        self.read_startup().recent_connection_ids
    }

    /// A connection was deleted: nothing of it is kept, and it is not the one to reopen.
    pub fn forget(&self, connection_id: &str) -> AppResult<()> {
        self.remove(connection_id)?;
        let _guard = self.lock.lock();
        let mut file = self.read_startup();
        let was_recent = file.recent_connection_ids.len();
        file.recent_connection_ids.retain(|id| id != connection_id);
        let was_last = file.last_connection_id.as_deref() == Some(connection_id);
        if was_last {
            file.last_connection_id = None;
        }
        if was_last || file.recent_connection_ids.len() != was_recent {
            self.write_startup(&file)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stores() -> Vec<(WorkspaceStore, Option<tempfile::TempDir>)> {
        let dir = tempfile::tempdir().unwrap();
        vec![
            (
                WorkspaceStore::open(&dir.path().join("w")).unwrap(),
                Some(dir),
            ),
            (WorkspaceStore::in_memory(), None),
        ]
    }

    #[test]
    fn a_workspace_is_kept_per_connection_and_replaced_whole() {
        for (store, _dir) in stores() {
            assert_eq!(store.load("abc-1").unwrap(), None);
            store.save("abc-1", r#"{"tabs":[1]}"#).unwrap();
            store.save("abc-2", r#"{"tabs":[2]}"#).unwrap();
            store.save("abc-1", r#"{"tabs":[3]}"#).unwrap();
            assert_eq!(
                store.load("abc-1").unwrap().as_deref(),
                Some(r#"{"tabs":[3]}"#)
            );
            assert_eq!(
                store.load("abc-2").unwrap().as_deref(),
                Some(r#"{"tabs":[2]}"#)
            );
            store.remove("abc-1").unwrap();
            store.remove("abc-1").unwrap(); // already gone
            assert_eq!(store.load("abc-1").unwrap(), None);
        }
    }

    #[test]
    fn ids_that_could_leave_the_folder_and_things_that_are_not_json_are_refused() {
        for (store, _dir) in stores() {
            for id in ["", "../x", "a/b", "a.b", "a b", &"x".repeat(65)] {
                assert!(store.save(id, "{}").is_err(), "{id:?}");
                assert!(store.load(id).is_err(), "{id:?}");
                assert!(store.remove(id).is_err(), "{id:?}");
            }
            assert!(store.save("ok", "not json").is_err());
            assert!(store.save("ok", "").is_err());
            let big = format!("\"{}\"", "x".repeat(MAX_WORKSPACE_BYTES));
            assert!(store.save("ok", &big).is_err());
            assert_eq!(store.load("ok").unwrap(), None);
        }
    }

    #[test]
    fn nothing_half_written_is_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::open(dir.path()).unwrap();
        store.save("c1", "{}").unwrap();
        store.set_last_connection(Some("c1")).unwrap();
        let mut names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        assert_eq!(names, ["c1.json", "startup.json"]);
    }

    #[test]
    fn launch_settings_default_to_reopening_and_are_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("w");
        let store = WorkspaceStore::open(&path).unwrap();
        let first = store.startup();
        assert!(first.restore_on_launch);
        assert_eq!(first.last_connection_id, None);

        store.set_last_connection(Some("conn-1")).unwrap();
        store.set_restore_on_launch(false).unwrap();
        // Another run of the app.
        let again = WorkspaceStore::open(&path).unwrap().startup();
        assert!(!again.restore_on_launch);
        assert_eq!(again.last_connection_id.as_deref(), Some("conn-1"));

        store.set_last_connection(None).unwrap();
        assert_eq!(store.startup().last_connection_id, None);
        assert!(store.set_last_connection(Some("../x")).is_err());
    }

    #[test]
    fn a_damaged_launch_file_means_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let store = WorkspaceStore::open(dir.path()).unwrap();
        fs::write(dir.path().join("startup.json"), "{{{ not json").unwrap();
        let startup = store.startup();
        assert!(startup.restore_on_launch);
        assert_eq!(startup.last_connection_id, None);
        // And it is replaced by the next change.
        store.set_restore_on_launch(false).unwrap();
        assert!(!store.startup().restore_on_launch);
    }

    #[test]
    fn deleting_a_connection_forgets_its_workspace_and_its_place_at_launch() {
        for (store, _dir) in stores() {
            store.save("gone", "{}").unwrap();
            store.save("kept", "{}").unwrap();
            store.set_last_connection(Some("gone")).unwrap();
            store.forget("gone").unwrap();
            assert_eq!(store.load("gone").unwrap(), None);
            assert_eq!(store.load("kept").unwrap().as_deref(), Some("{}"));
            assert_eq!(store.startup().last_connection_id, None);

            // Another connection stays the one to reopen.
            store.set_last_connection(Some("kept")).unwrap();
            store.forget("other").unwrap();
            assert_eq!(store.startup().last_connection_id.as_deref(), Some("kept"));
        }
    }

    #[test]
    fn recent_connections_are_latest_first_without_repeats_and_capped() {
        for (store, _dir) in stores() {
            assert!(store.recent_connections().is_empty());
            for id in ["a", "b", "c", "a"] {
                store.set_last_connection(Some(id)).unwrap();
            }
            assert_eq!(store.recent_connections(), ["a", "c", "b"]);

            // A disconnect is not an opening: the list stays as it was.
            store.set_last_connection(None).unwrap();
            assert_eq!(store.recent_connections(), ["a", "c", "b"]);

            // A deleted connection leaves the list.
            store.forget("c").unwrap();
            assert_eq!(store.recent_connections(), ["a", "b"]);

            for n in 0..20 {
                store.set_last_connection(Some(&format!("id-{n}"))).unwrap();
            }
            let recent = store.recent_connections();
            assert_eq!(recent.len(), MAX_RECENT_CONNECTIONS);
            assert_eq!(recent[0], "id-19");
        }
    }

    #[test]
    fn a_launch_file_from_before_recent_connections_still_reads() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("w");
        let store = WorkspaceStore::open(&folder).unwrap();
        fs::write(
            folder.join("startup.json"),
            r#"{"restoreOnLaunch":false,"lastConnectionId":"x"}"#,
        )
        .unwrap();
        assert!(!store.startup().restore_on_launch);
        assert_eq!(store.startup().last_connection_id.as_deref(), Some("x"));
        assert!(store.recent_connections().is_empty());
    }
}
