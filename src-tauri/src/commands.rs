//! Commands callable from the WebView. Every command must be registered in
//! [`crate::specta_builder`] so that its TypeScript binding is generated.

use db_editor_core::tsv;
use serde::Serialize;

/// Error returned to the frontend.
#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum CommandError {
    #[error("{0}")]
    InvalidInput(String),
}

/// Parses clipboard text as TSV.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri commands take owned arguments.
pub fn parse_tsv(text: String) -> Result<Vec<Vec<String>>, CommandError> {
    tsv::parse(&text).map_err(|error| CommandError::InvalidInput(error.to_string()))
}
