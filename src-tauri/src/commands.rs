//! Commands callable from the WebView. Every command must be registered in
//! [`crate::specta_builder`] so that its TypeScript binding is generated.
//!
//! Commands that act on a database use the calling window's connection, so a
//! window can only reach the connection it was opened for.

// Tauri commands take owned arguments.
#![allow(clippy::needless_pass_by_value)]

use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use db_editor_core::copy::{self, CopyFormat, CopyRequest};
use db_editor_core::edit::ChangeSet;
use db_editor_core::url::{self, ParsedUrl};
use db_editor_core::{sql, tsv};
use db_editor_pg::browse::{self, Page, PageRequest};
use db_editor_pg::catalog::{self, Schema, TableInfo};
use db_editor_pg::edit::{self as pg_edit, SaveOutcome};
use db_editor_pg::exec::{self, Outcome, StatementResult, TransactionStatus};
use db_editor_pg::{ConnectOptions, ErrorInfo};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::state::{AppState, Connected, CopiedCells};
use crate::store::{
    ConnectionProfile, Environment, HistoryEntry, KeyBinding, KeybindingsFile, SavedQuery,
    StoreError, password_key,
};

/// Category of a [`CommandError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    InvalidInput,
    /// Reported by PostgreSQL or the network.
    Database,
    /// The window has no open connection (never opened, or lost).
    NotConnected,
    /// Reading or writing app files or the credential store failed.
    Storage,
    /// The statements write to a production database; run again with `allow_writes`
    /// after the user confirms.
    ConfirmationRequired,
}

/// Error returned to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CommandError {
    pub kind: ErrorKind,
    pub message: String,
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub position: Option<u32>,
}

impl CommandError {
    fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            code: None,
            detail: None,
            hint: None,
            position: None,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::InvalidInput, message)
    }
}

impl From<ErrorInfo> for CommandError {
    fn from(info: ErrorInfo) -> Self {
        Self {
            kind: ErrorKind::Database,
            message: info.message,
            code: info.code,
            detail: info.detail,
            hint: info.hint,
            position: info.position,
        }
    }
}

impl From<db_editor_pg::Error> for CommandError {
    fn from(error: db_editor_pg::Error) -> Self {
        error.info().into()
    }
}

impl From<StoreError> for CommandError {
    fn from(error: StoreError) -> Self {
        let kind = match error {
            StoreError::Invalid(_) | StoreError::NotFound(_) => ErrorKind::InvalidInput,
            _ => ErrorKind::Storage,
        };
        Self::new(kind, error.to_string())
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// Parses clipboard text as TSV.
#[tauri::command]
#[specta::specta]
pub fn parse_tsv(text: String) -> Result<Vec<Vec<String>>, CommandError> {
    tsv::parse(&text).map_err(|error| CommandError::invalid(error.to_string()))
}

// ---------------------------------------------------------------------------
// Connection profiles (launcher)
// ---------------------------------------------------------------------------

/// Lists saved connections.
#[tauri::command]
#[specta::specta]
pub fn list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, CommandError> {
    Ok(state.profiles.list()?)
}

/// What to do with the stored password when saving a profile.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PasswordUpdate {
    Keep,
    Set { value: String },
    Clear,
}

/// Saves a connection (a new one when its id is empty) and returns it with its id.
#[tauri::command]
#[specta::specta]
pub fn save_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: PasswordUpdate,
) -> Result<ConnectionProfile, CommandError> {
    let saved = state.profiles.save(profile)?;
    let key = password_key(&saved.id);
    match password {
        PasswordUpdate::Keep => {}
        PasswordUpdate::Set { value } if value.is_empty() => state.secrets.delete(&key)?,
        PasswordUpdate::Set { value } => state.secrets.set(&key, &value)?,
        PasswordUpdate::Clear => state.secrets.delete(&key)?,
    }
    Ok(saved)
}

/// Deletes a connection and its stored password.
#[tauri::command]
#[specta::specta]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> Result<(), CommandError> {
    state.profiles.delete(&id)?;
    state.secrets.delete(&password_key(&id))?;
    Ok(())
}

/// Whether a password is stored for the connection.
#[tauri::command]
#[specta::specta]
pub fn has_saved_password(state: State<'_, AppState>, id: String) -> Result<bool, CommandError> {
    Ok(state.secrets.get(&password_key(&id))?.is_some())
}

/// Splits a `postgres://` URL into the dialog's fields.
#[tauri::command]
#[specta::specta]
pub fn parse_connection_url(url: String) -> Result<ParsedUrl, CommandError> {
    url::parse(&url).map_err(|e| CommandError::invalid(e.to_string()))
}

fn connect_options(
    profile: &ConnectionProfile,
    password: Option<String>,
    database: &str,
) -> ConnectOptions {
    ConnectOptions {
        host: profile.host.clone(),
        port: profile.port,
        user: profile.user.clone(),
        password,
        database: database.to_owned(),
        ssl: profile.ssl.clone(),
        read_only: profile.read_only,
        application_name: "db editor".to_owned(),
    }
}

/// Result of a connection test.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub server_version: String,
    pub elapsed_ms: u32,
}

/// Tries to connect with the dialog's settings. When `password` is `None`, the stored
/// password of the profile is used.
#[tauri::command]
#[specta::specta]
pub async fn test_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
    password: Option<String>,
) -> Result<TestResult, CommandError> {
    let password = match password {
        Some(p) => Some(p),
        None if !profile.id.is_empty() => state.secrets.get(&password_key(&profile.id))?,
        None => None,
    };
    let started = Instant::now();
    let session =
        db_editor_pg::open(&connect_options(&profile, password, &profile.database)).await?;
    let server_version = db_editor_pg::server_version(session.client()).await?;
    Ok(TestResult {
        server_version,
        elapsed_ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
    })
}

/// Opens a window for a saved connection. The window connects when it loads.
#[tauri::command]
#[specta::specta]
pub fn open_connection_window(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), CommandError> {
    let profile = state.profiles.get(&id)?;
    let label = state.register_window(&profile.id);
    let url = format!("index.html?connection={}", profile.id);
    let result = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(format!("{} — {}", profile.name, profile.database))
        .inner_size(1280.0, 820.0)
        .min_inner_size(720.0, 480.0)
        .build();
    if let Err(error) = result {
        state.remove_window(&label);
        return Err(CommandError::new(ErrorKind::Storage, error.to_string()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Connection window session
// ---------------------------------------------------------------------------

/// What a connection window shows about its connection.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub profile: ConnectionProfile,
    pub database: String,
    pub server_version: String,
}

fn info(connected: &Connected) -> SessionInfo {
    SessionInfo {
        profile: connected.profile.clone(),
        database: connected.database.clone(),
        server_version: connected.server_version.clone(),
    }
}

/// Connects the calling window to its profile, optionally to another database on
/// the same server. Replaces an existing connection of the window.
#[tauri::command]
#[specta::specta]
pub async fn session_connect(
    window: Window,
    state: State<'_, AppState>,
    database: Option<String>,
) -> Result<SessionInfo, CommandError> {
    let profile_id = state.window_profile(window.label()).ok_or_else(|| {
        CommandError::new(ErrorKind::NotConnected, "this window has no connection")
    })?;
    let profile = state.profiles.get(&profile_id)?;
    let password = state.secrets.get(&password_key(&profile.id))?;
    let database = database.unwrap_or_else(|| profile.database.clone());
    let options = connect_options(&profile, password, &database);
    let (browse, editor) =
        tokio::try_join!(db_editor_pg::open(&options), db_editor_pg::open(&options))?;
    let server_version = db_editor_pg::server_version(browse.client()).await?;
    let connected = Arc::new(Connected {
        profile,
        database,
        server_version,
        options,
        browse,
        editor,
        writer: tokio::sync::Mutex::new(None),
    });
    state.set_connected(window.label(), Some(Arc::clone(&connected)));
    if let Err(error) = state.profiles.touch(&profile_id, now_ms()) {
        tracing::warn!(%error, "could not record the connection time");
    }
    let env = match connected.profile.environment {
        Environment::Production => " [本番]",
        Environment::Staging | Environment::Development => "",
    };
    let _ = window.set_title(&format!(
        "{} — {}{env}",
        connected.profile.name, connected.database
    ));
    Ok(info(&connected))
}

fn connected(window: &Window, state: &AppState) -> Result<Arc<Connected>, CommandError> {
    let connected = state
        .connected(window.label())
        .ok_or_else(|| CommandError::new(ErrorKind::NotConnected, "not connected"))?;
    if connected.browse.is_closed() || connected.editor.is_closed() {
        return Err(CommandError::new(
            ErrorKind::NotConnected,
            "the connection was closed by the server or the network",
        ));
    }
    Ok(connected)
}

/// Lists databases on the server of the window's connection.
#[tauri::command]
#[specta::specta]
pub async fn list_databases(
    window: Window,
    state: State<'_, AppState>,
) -> Result<Vec<String>, CommandError> {
    let c = connected(&window, &state)?;
    Ok(catalog::databases(c.browse.client()).await?)
}

/// Reads the schema tree.
#[tauri::command]
#[specta::specta]
pub async fn load_schemas(
    window: Window,
    state: State<'_, AppState>,
) -> Result<Vec<Schema>, CommandError> {
    let c = connected(&window, &state)?;
    Ok(catalog::schemas(c.browse.client()).await?)
}

/// Reads columns, keys, indexes and references of a relation.
#[tauri::command]
#[specta::specta]
pub async fn table_info(
    window: Window,
    state: State<'_, AppState>,
    schema: String,
    table: String,
) -> Result<TableInfo, CommandError> {
    let c = connected(&window, &state)?;
    Ok(catalog::table_info(c.browse.client(), &schema, &table).await?)
}

/// Builds the DDL of a relation.
#[tauri::command]
#[specta::specta]
pub async fn table_ddl(
    window: Window,
    state: State<'_, AppState>,
    schema: String,
    table: String,
) -> Result<String, CommandError> {
    let c = connected(&window, &state)?;
    Ok(catalog::ddl(c.browse.client(), &schema, &table).await?)
}

/// Fetches one page of table rows.
#[tauri::command]
#[specta::specta]
pub async fn fetch_page(
    window: Window,
    state: State<'_, AppState>,
    request: PageRequest,
) -> Result<Page, CommandError> {
    let c = connected(&window, &state)?;
    Ok(browse::fetch_page(c.browse.client(), &request).await?)
}

/// Counts rows of another table that reference a row, up to `limit + 1`.
#[tauri::command]
#[specta::specta]
pub async fn count_references(
    window: Window,
    state: State<'_, AppState>,
    schema: String,
    table: String,
    columns: Vec<String>,
    values: Vec<Option<String>>,
    limit: u32,
) -> Result<u32, CommandError> {
    let c = connected(&window, &state)?;
    let count =
        browse::count_matching(c.browse.client(), &schema, &table, &columns, &values, limit)
            .await?;
    // The query stops counting at `limit + 1`.
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// Which statements of the editor text to run.
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunMode {
    /// The statement under the cursor (a UTF-16 offset, as JavaScript counts).
    Cursor { position: u32 },
    /// Every statement in the text.
    All,
}

/// A statement's location in the editor text, in UTF-16 offsets.
#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub from: u32,
    pub to: u32,
}

/// Results of a run.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub results: Vec<StatementResult>,
    /// Ranges of the statements that were run, in order.
    pub ranges: Vec<TextRange>,
    pub transaction: TransactionStatus,
}

fn utf16_to_byte(text: &str, utf16: u32) -> usize {
    let mut units = 0u32;
    for (i, c) in text.char_indices() {
        if units >= utf16 {
            return i;
        }
        units += u32::try_from(c.len_utf16()).unwrap_or(2);
    }
    text.len()
}

fn byte_to_utf16(text: &str, byte: usize) -> u32 {
    u32::try_from(text.get(..byte).map_or(0, |s| s.encode_utf16().count())).unwrap_or(u32::MAX)
}

/// Whether a statement may change data or schema. Unknown statements count as writes.
fn is_write(statement: &str) -> bool {
    let keyword = sql::first_keyword(statement);
    let read = matches!(
        keyword.as_str(),
        "SELECT"
            | "SHOW"
            | "EXPLAIN"
            | "VALUES"
            | "TABLE"
            | "BEGIN"
            | "START"
            | "COMMIT"
            | "END"
            | "ROLLBACK"
            | "ABORT"
            | "SAVEPOINT"
            | "RELEASE"
            | "SET"
            | "RESET"
            | "FETCH"
            | "DECLARE"
            | "CLOSE"
            | "LISTEN"
            | "UNLISTEN"
            | "DISCARD"
    );
    // A data-modifying CTE (`WITH x AS (DELETE ...)`) is a write.
    let modifying_cte = keyword == "WITH" && {
        let upper = statement.to_ascii_uppercase();
        ["INSERT ", "UPDATE ", "DELETE ", "MERGE "]
            .iter()
            .any(|k| upper.contains(k))
    };
    !(read || (keyword == "WITH" && !modifying_cte))
}

fn summary(result: &StatementResult) -> (String, bool) {
    match &result.outcome {
        Outcome::Rows { total_rows, .. } => (format!("{total_rows} rows"), true),
        Outcome::Command {
            command,
            rows_affected,
        } => (format!("{command} {rows_affected}"), true),
        Outcome::Error { error } => (error.message.clone(), false),
    }
}

/// Runs SQL from the editor on the window's editor session.
#[tauri::command]
#[specta::specta]
pub async fn run_sql(
    window: Window,
    state: State<'_, AppState>,
    sql: String,
    mode: RunMode,
    allow_writes: bool,
) -> Result<RunResult, CommandError> {
    let c = connected(&window, &state)?;
    let ranges = sql::split_statements(&sql);
    let selected: Vec<std::ops::Range<usize>> = match mode {
        RunMode::All => ranges,
        RunMode::Cursor { position } => {
            let byte = utf16_to_byte(&sql, position);
            sql::statement_at(&ranges, byte)
                .and_then(|i| ranges.get(i).cloned())
                .into_iter()
                .collect()
        }
    };
    if selected.is_empty() {
        return Err(CommandError::invalid("there is no statement to run"));
    }
    let statements: Vec<String> = selected.iter().map(|r| sql[r.clone()].to_owned()).collect();
    if !allow_writes
        && c.profile.environment == Environment::Production
        && !c.profile.read_only
        && statements.iter().any(|s| is_write(s))
    {
        return Err(CommandError::new(
            ErrorKind::ConfirmationRequired,
            "production database: these statements may change data",
        ));
    }
    let results = exec::run(c.editor.client(), &statements).await;
    let transaction = exec::transaction_status(c.editor.client()).await;

    if let Some(last) = results.last() {
        let (summary, ok) = summary(last);
        let entry = HistoryEntry {
            sql: statements[..results.len()].join(";\n"),
            executed_at: now_ms(),
            elapsed_ms: results.iter().map(|r| r.elapsed_ms).sum(),
            summary,
            ok,
        };
        if let Err(error) = state.history.append(&c.profile.id, &entry) {
            tracing::warn!(%error, "could not write the query history");
        }
    }
    Ok(RunResult {
        ranges: selected
            .iter()
            .map(|r| TextRange {
                from: byte_to_utf16(&sql, r.start),
                to: byte_to_utf16(&sql, r.end),
            })
            .collect(),
        results,
        transaction,
    })
}

/// Cancels the query running in the editor.
#[tauri::command]
#[specta::specta]
pub async fn cancel_query(window: Window, state: State<'_, AppState>) -> Result<(), CommandError> {
    let c = connected(&window, &state)?;
    Ok(c.editor.cancel().await?)
}

/// Returns the query history of the window's connection, newest first.
#[tauri::command]
#[specta::specta]
pub fn query_history(
    window: Window,
    state: State<'_, AppState>,
) -> Result<Vec<HistoryEntry>, CommandError> {
    let id = state
        .window_profile(window.label())
        .ok_or_else(|| CommandError::new(ErrorKind::NotConnected, "not connected"))?;
    Ok(state.history.list(&id)?)
}

fn window_profile_id(window: &Window, state: &AppState) -> Result<String, CommandError> {
    state
        .window_profile(window.label())
        .ok_or_else(|| CommandError::new(ErrorKind::NotConnected, "not connected"))
}

/// Lists the saved queries of the window's connection.
#[tauri::command]
#[specta::specta]
pub fn list_saved_queries(
    window: Window,
    state: State<'_, AppState>,
) -> Result<Vec<SavedQuery>, CommandError> {
    let id = window_profile_id(&window, &state)?;
    Ok(state.saved_queries.list(&id)?)
}

/// Saves a query as `<name>.sql` for the window's connection.
#[tauri::command]
#[specta::specta]
pub fn save_query(
    window: Window,
    state: State<'_, AppState>,
    name: String,
    sql: String,
) -> Result<SavedQuery, CommandError> {
    let id = window_profile_id(&window, &state)?;
    Ok(state.saved_queries.save(&id, &name, &sql)?)
}

/// Deletes a saved query of the window's connection.
#[tauri::command]
#[specta::specta]
pub fn delete_saved_query(
    window: Window,
    state: State<'_, AppState>,
    name: String,
) -> Result<(), CommandError> {
    let id = window_profile_id(&window, &state)?;
    Ok(state.saved_queries.delete(&id, &name)?)
}

// ---------------------------------------------------------------------------
// Row editing
// ---------------------------------------------------------------------------

/// The statements that saving the changes would run, for the preview (⌘⇧S).
#[tauri::command]
#[specta::specta]
pub fn preview_changes(changes: ChangeSet) -> Result<Vec<String>, CommandError> {
    changes
        .statements()
        .map_err(|e| CommandError::invalid(e.to_string()))
}

/// Saves row changes in one transaction. On a production connection the frontend
/// must confirm first and pass `allow_writes`.
#[tauri::command]
#[specta::specta]
pub async fn save_changes(
    window: Window,
    state: State<'_, AppState>,
    changes: ChangeSet,
    allow_writes: bool,
) -> Result<SaveOutcome, CommandError> {
    let c = connected(&window, &state)?;
    if c.profile.read_only {
        return Err(CommandError::invalid("this connection is read-only"));
    }
    if !allow_writes && c.profile.environment == Environment::Production {
        return Err(CommandError::new(
            ErrorKind::ConfirmationRequired,
            "production database: confirm before saving",
        ));
    }
    let mut writer = c.writer.lock().await;
    if writer.as_ref().is_none_or(db_editor_pg::Session::is_closed) {
        *writer = Some(db_editor_pg::open(&c.options).await?);
    }
    let Some(session) = writer.as_mut() else {
        return Err(CommandError::new(ErrorKind::NotConnected, "not connected"));
    };
    Ok(pg_edit::apply(session.client_mut(), &changes).await?)
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/// Renders a grid selection in the requested format and puts it on the clipboard.
/// Returns the copied text.
#[tauri::command]
#[specta::specta]
pub fn copy_selection(app: AppHandle, request: CopyRequest) -> Result<String, CommandError> {
    let text = copy::render(&request).map_err(|e| CommandError::invalid(e.to_string()))?;
    write_text(&app, &text)?;
    // Remember TSV copies with their NULLs, which the text loses, for a paste.
    let header = match request.format {
        CopyFormat::Tsv => Some(Vec::new()),
        CopyFormat::TsvWithHeader => Some(vec![
            request
                .columns
                .iter()
                .map(|c| Some(c.name.clone()))
                .collect(),
        ]),
        _ => None,
    };
    if let Some(state) = app.try_state::<AppState>() {
        let copied = header.map(|header| CopiedCells {
            text: text.clone(),
            cells: header.into_iter().chain(request.rows.clone()).collect(),
        });
        *state
            .last_copy
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = copied;
    }
    Ok(text)
}

/// Clipboard text for a paste.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContent {
    pub text: String,
    /// The copied cells with their NULLs, when the text is still what this app last
    /// copied from a grid (in any window).
    pub cells: Option<Vec<Vec<Option<String>>>>,
}

/// Reads the clipboard for a paste. Empty when it holds no text.
#[tauri::command]
#[specta::specta]
pub fn read_clipboard(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClipboardContent, CommandError> {
    let text = app.clipboard().read_text().unwrap_or_default();
    let cells = state
        .last_copy
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .filter(|c| c.text == text)
        .map(|c| c.cells.clone());
    Ok(ClipboardContent { text, cells })
}

/// Puts text on the clipboard.
#[tauri::command]
#[specta::specta]
pub fn write_clipboard(app: AppHandle, text: String) -> Result<(), CommandError> {
    write_text(&app, &text)
}

fn write_text(app: &AppHandle, text: &str) -> Result<(), CommandError> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| CommandError::new(ErrorKind::Storage, e.to_string()))
}

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------

/// Reads the user key bindings (`keybindings.json`).
#[tauri::command]
#[specta::specta]
pub fn load_keybindings(state: State<'_, AppState>) -> Result<KeybindingsFile, CommandError> {
    Ok(state.keybindings.load()?)
}

/// Replaces the user key bindings.
#[tauri::command]
#[specta::specta]
pub fn save_keybindings(
    state: State<'_, AppState>,
    bindings: Vec<KeyBinding>,
) -> Result<(), CommandError> {
    Ok(state.keybindings.save(&bindings)?)
}

/// Closes connections of windows that are gone. Called from the window event handler.
pub fn forget_window(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        state.remove_window(label);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_writes() {
        assert!(!is_write("select 1"));
        assert!(!is_write("-- c\nWITH a AS (SELECT 1) SELECT * FROM a"));
        assert!(is_write(
            "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
        ));
        assert!(is_write("update t set a = 1"));
        assert!(is_write("vacuum"));
    }

    #[test]
    fn utf16_offsets_round_trip_through_bytes() {
        let text = "select '日本😀'; select 2";
        // "select '日本😀'" is 8 + 2 + 2 (surrogate pair) + 1 = 13 UTF-16 units.
        let byte = utf16_to_byte(text, 13);
        assert_eq!(&text[..byte], "select '日本😀'");
        assert_eq!(byte_to_utf16(text, byte), 13);
        assert_eq!(utf16_to_byte(text, 999), text.len());
    }
}
