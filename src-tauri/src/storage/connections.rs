use std::fs::{self, File};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::models::connection::ConnectionConfig;

pub const FILE_NAME: &str = "connections.json";
const FORMAT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct FileFormat {
    version: u32,
    connections: Vec<ConnectionConfig>,
}

/// The saved-connections file. Stateless: every call reads or writes the file, so a corrupt
/// file shows up as an error on the call instead of being silently replaced.
pub struct ConnectionStore {
    path: PathBuf,
}

impl ConnectionStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join(FILE_NAME),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn read(&self) -> AppResult<Vec<ConnectionConfig>> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(self.error(format!("cannot read it ({e})"))),
        };

        let file: FileFormat = serde_json::from_str(&text).map_err(|e| {
            self.error(format!(
                "it is not valid ({e}). Fix or delete the file; it was not changed"
            ))
        })?;
        if file.version > FORMAT_VERSION {
            return Err(self.error(format!(
                "it was written by a newer version of AngkorDB (format {})",
                file.version
            )));
        }
        Ok(file.connections)
    }

    /// Write atomically: a temp file in the same folder, then rename over the original.
    pub fn write(&self, connections: &[ConnectionConfig]) -> AppResult<()> {
        let dir = self.path.parent().unwrap_or(Path::new("."));
        fs::create_dir_all(dir)
            .map_err(|e| self.error(format!("cannot create its folder ({e})")))?;

        let json = serde_json::to_string_pretty(&FileFormat {
            version: FORMAT_VERSION,
            connections: connections.to_vec(),
        })
        .map_err(|e| self.error(e.to_string()))?;

        let tmp = self.path.with_extension("json.tmp");
        let write = || -> std::io::Result<()> {
            let mut file = File::create(&tmp)?;
            file.write_all(json.as_bytes())?;
            file.sync_all()?;
            fs::rename(&tmp, &self.path)
        };
        write().map_err(|e| {
            let _ = fs::remove_file(&tmp);
            self.error(format!("cannot write it ({e})"))
        })
    }

    fn error(&self, what: String) -> AppError {
        AppError::Storage(format!("{}: {what}", self.path.display()))
    }
}
