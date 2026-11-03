//! Saves a [`ChangeSet`] in one transaction (spec 3.5).

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, SimpleQueryMessage};

use db_editor_core::edit::{ChangeSet, expects_one_row};

use crate::{Error, ErrorInfo};

/// The rows stored by a successful save.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    /// Columns of the returned rows (the table's columns).
    pub columns: Vec<String>,
    /// For each change, the row as stored (`RETURNING *`); `None` for deletes and for
    /// an upsert that changed nothing.
    pub rows: Vec<Option<Vec<Option<String>>>>,
    pub elapsed_ms: u32,
}

/// Outcome of a save. A failure rolls back every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SaveOutcome {
    Saved(Saved),
    Failed {
        /// The change that failed, when the failure belongs to one.
        index: Option<u32>,
        error: ErrorInfo,
    },
}

fn failed(index: usize, error: ErrorInfo) -> SaveOutcome {
    SaveOutcome::Failed {
        index: u32::try_from(index).ok(),
        error,
    }
}

fn message(text: impl Into<String>) -> ErrorInfo {
    ErrorInfo {
        message: text.into(),
        code: None,
        detail: None,
        hint: None,
        position: None,
    }
}

/// Runs every change of `set` in one transaction. `UPDATE` and `DELETE` must each
/// affect exactly one row; otherwise the save is rolled back.
///
/// # Errors
///
/// Returns an error only when the transaction cannot be started or committed;
/// a failing change is reported as [`SaveOutcome::Failed`].
pub async fn apply(client: &mut Client, set: &ChangeSet) -> Result<SaveOutcome, Error> {
    let statements = match set.statements() {
        Ok(s) => s,
        Err(e) => return Ok(failed(0, message(e.to_string()))),
    };
    let started = Instant::now();
    let tx = client.transaction().await?;
    let mut columns: Vec<String> = Vec::new();
    let mut rows = Vec::with_capacity(statements.len());
    for (i, (sql, change)) in statements.iter().zip(&set.changes).enumerate() {
        let messages = match tx.simple_query(sql).await {
            Ok(m) => m,
            // Dropping `tx` rolls back.
            Err(e) => return Ok(failed(i, Error::from(e).info())),
        };
        let mut row = None;
        let mut affected = 0;
        for m in messages {
            match m {
                SimpleQueryMessage::RowDescription(cols) if columns.is_empty() => {
                    columns = cols.iter().map(|c| c.name().to_owned()).collect();
                }
                SimpleQueryMessage::Row(r) => {
                    row = Some((0..r.len()).map(|j| r.get(j).map(str::to_owned)).collect());
                }
                SimpleQueryMessage::CommandComplete(n) => affected = n,
                _ => {}
            }
        }
        if expects_one_row(change) && affected != 1 {
            let text = if affected == 0 {
                "the row was not found: it may have been deleted, or its key changed, since it was loaded"
            } else {
                "the row key matched more than one row"
            };
            return Ok(failed(i, message(text)));
        }
        rows.push(row);
    }
    tx.commit().await?;
    Ok(SaveOutcome::Saved(Saved {
        columns,
        rows,
        elapsed_ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
    }))
}
