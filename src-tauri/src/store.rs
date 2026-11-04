//! Files the app keeps on disk: connection profiles, query history and saved queries.
//!
//! Passwords never go into these files; they live in the OS credential store
//! (see [`Secrets`]).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use db_editor_pg::SslOptions;
use serde::{Deserialize, Serialize};

/// Environment label of a connection (spec 3.2). Production shows a red band and
/// defaults to read-only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    #[default]
    Development,
    Staging,
    Production,
}

/// A saved connection. The password is stored separately in the credential store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    /// Empty for a profile that has not been saved yet.
    pub id: String,
    pub name: String,
    /// CSS color such as `#2f8a57`.
    pub color: String,
    pub environment: Environment,
    /// Launcher group, for example "Work"; empty for none.
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub ssl: SslOptions,
    #[serde(default)]
    pub read_only: bool,
    /// Unix time in milliseconds of the last connection.
    #[serde(default)]
    pub last_used_at: Option<f64>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProfilesFile {
    connections: Vec<ConnectionProfile>,
}

/// Errors reading or writing app files.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("connection {0} not found")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error("credential store: {0}")]
    Secret(String),
}

/// Writes through a temporary file and a rename, so a crash never leaves a half-written file.
fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), StoreError> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)?;
    Ok(())
}

/// Connection profiles in `connections.json`.
pub struct Profiles {
    path: PathBuf,
}

impl Profiles {
    #[must_use]
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("connections.json"),
        }
    }

    /// Lists all profiles in the saved order.
    ///
    /// # Errors
    ///
    /// Returns an error when the file exists but cannot be read or parsed.
    pub fn list(&self) -> Result<Vec<ConnectionProfile>, StoreError> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice::<ProfilesFile>(&bytes)?.connections),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    fn write(&self, connections: Vec<ConnectionProfile>) -> Result<(), StoreError> {
        let json = serde_json::to_vec_pretty(&ProfilesFile { connections })?;
        write_atomic(&self.path, &json)
    }

    /// Looks up a profile.
    ///
    /// # Errors
    ///
    /// [`StoreError::NotFound`] when there is no such profile.
    pub fn get(&self, id: &str) -> Result<ConnectionProfile, StoreError> {
        self.list()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or_else(|| StoreError::NotFound(id.to_owned()))
    }

    /// Adds a profile (when its id is empty) or replaces the one with the same id.
    ///
    /// # Errors
    ///
    /// Returns an error when the profile is invalid or the file cannot be written.
    pub fn save(&self, mut profile: ConnectionProfile) -> Result<ConnectionProfile, StoreError> {
        if profile.name.trim().is_empty() {
            return Err(StoreError::Invalid("name is required".to_owned()));
        }
        if profile.host.trim().is_empty() {
            return Err(StoreError::Invalid("host is required".to_owned()));
        }
        let mut all = self.list()?;
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
            all.push(profile.clone());
        } else if let Some(existing) = all.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile.clone();
        } else {
            return Err(StoreError::NotFound(profile.id));
        }
        self.write(all)?;
        Ok(profile)
    }

    /// Removes a profile. Removing a missing profile is not an error.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be written.
    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        let mut all = self.list()?;
        all.retain(|p| p.id != id);
        self.write(all)
    }

    /// Records the time of a successful connection, shown in the launcher.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be written.
    pub fn touch(&self, id: &str, now_ms: f64) -> Result<(), StoreError> {
        let mut all = self.list()?;
        if let Some(p) = all.iter_mut().find(|p| p.id == id) {
            p.last_used_at = Some(now_ms);
        }
        self.write(all)
    }
}

/// Where passwords are kept.
pub trait Secrets: Send + Sync {
    /// Returns the stored password, or `None` when there is none.
    ///
    /// # Errors
    ///
    /// Returns an error when the credential store is unavailable.
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;

    /// Stores a password.
    ///
    /// # Errors
    ///
    /// Returns an error when the credential store is unavailable.
    fn set(&self, key: &str, value: &str) -> Result<(), StoreError>;

    /// Deletes a password; deleting a missing one is not an error.
    ///
    /// # Errors
    ///
    /// Returns an error when the credential store is unavailable.
    fn delete(&self, key: &str) -> Result<(), StoreError>;
}

/// macOS Keychain or the Linux Secret Service.
pub struct KeyringSecrets;

const KEYRING_SERVICE: &str = "dev.dbeditor.app";

fn secret_error(e: impl std::fmt::Display) -> StoreError {
    StoreError::Secret(e.to_string())
}

impl Secrets for KeyringSecrets {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(secret_error)?;
        match entry.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(secret_error(e)),
        }
    }

    fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        keyring::Entry::new(KEYRING_SERVICE, key)
            .and_then(|e| e.set_password(value))
            .map_err(secret_error)
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, key).map_err(secret_error)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(secret_error(e)),
        }
    }
}

/// Key of a connection's password in the credential store.
#[must_use]
pub fn password_key(connection_id: &str) -> String {
    format!("connection:{connection_id}")
}

/// One executed query in the history (spec 3.7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub sql: String,
    /// Unix time in milliseconds.
    pub executed_at: f64,
    pub elapsed_ms: u32,
    /// Short outcome such as "7 rows", "UPDATE 3" or the error message.
    pub summary: String,
    pub ok: bool,
}

/// Entries kept per connection; older ones are dropped.
const HISTORY_LIMIT: usize = 1000;

/// Query history, one JSON-lines file per connection.
pub struct History {
    dir: PathBuf,
}

impl History {
    #[must_use]
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("history"),
        }
    }

    fn path(&self, connection_id: &str) -> Result<PathBuf, StoreError> {
        Ok(self
            .dir
            .join(format!("{}.jsonl", safe_file_stem(connection_id)?)))
    }

    /// Returns the history, newest first. Lines that cannot be parsed are skipped.
    ///
    /// # Errors
    ///
    /// Returns an error when the file exists but cannot be read.
    pub fn list(&self, connection_id: &str) -> Result<Vec<HistoryEntry>, StoreError> {
        let text = match fs::read_to_string(self.path(connection_id)?) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut entries: Vec<HistoryEntry> = text
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        entries.reverse();
        Ok(entries)
    }

    /// Appends an entry and trims the file to the newest [`HISTORY_LIMIT`] entries.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be written.
    pub fn append(&self, connection_id: &str, entry: &HistoryEntry) -> Result<(), StoreError> {
        let path = self.path(connection_id)?;
        fs::create_dir_all(&self.dir)?;
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?
            .write_all(line.as_bytes())?;

        let text = fs::read_to_string(&path)?;
        let count = text.lines().count();
        // Trim with some slack so the file is not rewritten on every append.
        if count > HISTORY_LIMIT + HISTORY_LIMIT / 10 {
            let kept: Vec<&str> = text.lines().skip(count - HISTORY_LIMIT).collect();
            write_atomic(&path, (kept.join("\n") + "\n").as_bytes())?;
        }
        Ok(())
    }
}

/// A saved query: a `.sql` file in the connection's folder (spec 3.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    /// File name without `.sql`.
    pub name: String,
    pub sql: String,
}

/// Saved queries as plain `.sql` files, so the folder can be kept in Git.
pub struct SavedQueries {
    dir: PathBuf,
}

impl SavedQueries {
    #[must_use]
    pub fn new(config_dir: &Path) -> Self {
        Self {
            dir: config_dir.join("queries"),
        }
    }

    fn folder(&self, connection_id: &str) -> Result<PathBuf, StoreError> {
        Ok(self.dir.join(safe_file_stem(connection_id)?))
    }

    /// Lists saved queries sorted by name.
    ///
    /// # Errors
    ///
    /// Returns an error when the folder cannot be read.
    pub fn list(&self, connection_id: &str) -> Result<Vec<SavedQuery>, StoreError> {
        let dir = self.folder(connection_id)?;
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for entry in entries {
            let path = entry?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("sql") {
                continue;
            }
            if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
                out.push(SavedQuery {
                    name: name.to_owned(),
                    sql: fs::read_to_string(&path)?,
                });
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// Saves (or overwrites) a query.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name or when the file cannot be written.
    pub fn save(
        &self,
        connection_id: &str,
        name: &str,
        sql: &str,
    ) -> Result<SavedQuery, StoreError> {
        let name = safe_file_stem(name.trim().trim_end_matches(".sql"))?;
        write_atomic(
            &self.folder(connection_id)?.join(format!("{name}.sql")),
            sql.as_bytes(),
        )?;
        Ok(SavedQuery {
            name,
            sql: sql.to_owned(),
        })
    }

    /// Deletes a saved query; deleting a missing one is not an error.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name or when the file cannot be removed.
    pub fn delete(&self, connection_id: &str, name: &str) -> Result<(), StoreError> {
        let path = self
            .folder(connection_id)?
            .join(format!("{}.sql", safe_file_stem(name)?));
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// One entry of `keybindings.json` (spec 5.3), in the format VS Code uses.
///
/// `key` is one or two chords such as `mod+shift+d` or `mod+k mod+s`. A `command`
/// starting with `-` removes a default binding of that key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyBinding {
    pub key: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

/// The user's key bindings and where they are stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KeybindingsFile {
    /// Absolute path of `keybindings.json`, shown so it can be edited directly.
    pub path: String,
    /// Changes to the default bindings; empty when the file does not exist.
    pub bindings: Vec<KeyBinding>,
}

/// User key bindings in `keybindings.json` in the config folder.
pub struct Keybindings {
    path: PathBuf,
}

impl Keybindings {
    #[must_use]
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join("keybindings.json"),
        }
    }

    /// Reads the user bindings.
    ///
    /// # Errors
    ///
    /// Returns an error when the file exists but is not a JSON array of bindings.
    pub fn load(&self) -> Result<KeybindingsFile, StoreError> {
        let bindings = match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(KeybindingsFile {
            path: self.path.display().to_string(),
            bindings,
        })
    }

    /// Replaces the user bindings.
    ///
    /// # Errors
    ///
    /// Returns an error when a binding has no key or command, or the file cannot be written.
    pub fn save(&self, bindings: &[KeyBinding]) -> Result<(), StoreError> {
        if let Some(b) = bindings
            .iter()
            .find(|b| b.key.trim().is_empty() || b.command.trim().is_empty())
        {
            return Err(StoreError::Invalid(format!(
                "a key binding needs a key and a command: {b:?}"
            )));
        }
        let mut json = serde_json::to_vec_pretty(bindings)?;
        json.push(b'\n');
        write_atomic(&self.path, &json)
    }
}

/// Accepts a name usable as a file name on macOS and Linux: no path separators,
/// no leading dot, not empty.
fn safe_file_stem(name: &str) -> Result<String, StoreError> {
    let invalid = name.is_empty()
        || name.starts_with('.')
        || name.contains(['/', '\\', '\0', ':'])
        || name.len() > 200;
    if invalid {
        Err(StoreError::Invalid(format!("invalid name: {name:?}")))
    } else {
        Ok(name.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keybindings_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Keybindings::new(dir.path());
        assert!(store.load().unwrap().bindings.is_empty());
        let bindings = vec![
            KeyBinding {
                key: "mod+shift+d".into(),
                command: "table.duplicateRow".into(),
                when: Some("focus == grid".into()),
            },
            KeyBinding {
                key: "mod+d".into(),
                command: "-table.duplicateRow".into(),
                when: None,
            },
        ];
        store.save(&bindings).unwrap();
        assert_eq!(store.load().unwrap().bindings, bindings);
        let text = fs::read_to_string(dir.path().join("keybindings.json")).unwrap();
        assert!(!text.contains("\"when\": null"), "{text}");

        fs::write(dir.path().join("keybindings.json"), "{ not json").unwrap();
        assert!(matches!(store.load(), Err(StoreError::Json(_))));
        assert!(matches!(
            store.save(&[KeyBinding {
                key: " ".into(),
                command: "x".into(),
                when: None
            }]),
            Err(StoreError::Invalid(_))
        ));
    }

    fn profile(name: &str) -> ConnectionProfile {
        ConnectionProfile {
            id: String::new(),
            name: name.to_owned(),
            color: "#2f8a57".to_owned(),
            environment: Environment::Development,
            group: String::new(),
            host: "localhost".to_owned(),
            port: 5432,
            database: "postgres".to_owned(),
            user: "postgres".to_owned(),
            ssl: SslOptions::default(),
            read_only: false,
            last_used_at: None,
        }
    }

    #[test]
    fn profiles_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = Profiles::new(dir.path());
        assert!(profiles.list().unwrap().is_empty());

        let saved = profiles.save(profile("dev")).unwrap();
        assert!(!saved.id.is_empty());
        let mut changed = saved.clone();
        changed.name = "renamed".to_owned();
        profiles.save(changed).unwrap();
        profiles.touch(&saved.id, 42.0).unwrap();

        let loaded = profiles.get(&saved.id).unwrap();
        assert_eq!(loaded.name, "renamed");
        assert_eq!(loaded.last_used_at, Some(42.0));
        // The password is never written to the profile file.
        let raw = fs::read_to_string(dir.path().join("connections.json")).unwrap();
        assert!(!raw.contains("password"));

        profiles.delete(&saved.id).unwrap();
        assert!(profiles.list().unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_profiles() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = Profiles::new(dir.path());
        assert!(profiles.save(profile(" ")).is_err());
        let mut unknown = profile("x");
        unknown.id = "missing".to_owned();
        assert!(matches!(
            profiles.save(unknown),
            Err(StoreError::NotFound(_))
        ));
    }

    #[test]
    fn history_is_newest_first_and_trimmed() {
        let dir = tempfile::tempdir().unwrap();
        let history = History::new(dir.path());
        for i in 0..(HISTORY_LIMIT + HISTORY_LIMIT / 10 + 1) {
            history
                .append(
                    "c1",
                    &HistoryEntry {
                        sql: format!("select {i}"),
                        executed_at: i as f64,
                        elapsed_ms: 1,
                        summary: "1 row".to_owned(),
                        ok: true,
                    },
                )
                .unwrap();
        }
        let entries = history.list("c1").unwrap();
        assert_eq!(entries.len(), HISTORY_LIMIT);
        assert_eq!(
            entries[0].sql,
            format!("select {}", HISTORY_LIMIT + HISTORY_LIMIT / 10)
        );
        assert!(history.list("other").unwrap().is_empty());
    }

    #[test]
    fn saved_queries_are_sql_files() {
        let dir = tempfile::tempdir().unwrap();
        let queries = SavedQueries::new(dir.path());
        queries.save("c1", "月次売上.sql", "select 1;").unwrap();
        queries.save("c1", "a", "select 2;").unwrap();
        let list = queries.list("c1").unwrap();
        assert_eq!(
            list.iter().map(|q| q.name.as_str()).collect::<Vec<_>>(),
            vec!["a", "月次売上"]
        );
        assert!(dir.path().join("queries/c1/月次売上.sql").exists());
        assert!(queries.save("c1", "../escape", "x").is_err());
        queries.delete("c1", "a").unwrap();
        assert_eq!(queries.list("c1").unwrap().len(), 1);
    }
}
