//! Runs statements typed in the SQL editor.

use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, SimpleQueryMessage};

use db_editor_core::sql::first_keyword;

use crate::{Error, ErrorInfo};

/// Rows kept per result; the rest are counted but not sent to the UI.
pub const MAX_RESULT_ROWS: usize = 10_000;

/// A column of a result set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    /// Type name when it could be determined, for example `int8` or `timestamptz`.
    pub type_name: Option<String>,
}

/// What one statement produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Outcome {
    Rows {
        columns: Vec<ResultColumn>,
        rows: Vec<Vec<Option<String>>>,
        /// Rows returned by the server, including those beyond [`MAX_RESULT_ROWS`].
        #[specta(type = f64)]
        total_rows: u64,
    },
    Command {
        /// The statement's first keyword, for example `UPDATE`.
        command: String,
        #[specta(type = f64)]
        rows_affected: u64,
    },
    Error {
        error: ErrorInfo,
    },
}

/// Result of one statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    pub sql: String,
    pub outcome: Outcome,
    pub elapsed_ms: u32,
}

/// Transaction state of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TransactionStatus {
    /// Autocommit: every statement commits on its own.
    Idle,
    /// Inside `BEGIN`.
    InTransaction,
    /// Inside a transaction that failed; only `ROLLBACK` is accepted.
    Failed,
}

/// Runs statements one by one and stops at the first error.
pub async fn run(client: &Client, statements: &[String]) -> Vec<StatementResult> {
    let mut results = Vec::with_capacity(statements.len());
    for sql in statements {
        let result = run_one(client, sql).await;
        let failed = matches!(result.outcome, Outcome::Error { .. });
        results.push(result);
        if failed {
            break;
        }
    }
    results
}

async fn column_types(client: &Client, sql: &str) -> Vec<Option<String>> {
    // Preparing tells the column types without running the statement. It fails for
    // statements with parameters or inside a failed transaction; types are then unknown.
    match client.prepare(sql).await {
        Ok(statement) => statement
            .columns()
            .iter()
            .map(|c| Some(c.type_().name().to_owned()))
            .collect(),
        Err(_) => Vec::new(),
    }
}

async fn run_one(client: &Client, sql: &str) -> StatementResult {
    let started = Instant::now();
    let keyword = first_keyword(sql);
    // Only result-producing statements need column types.
    let types = if matches!(
        keyword.as_str(),
        "SELECT"
            | "WITH"
            | "VALUES"
            | "TABLE"
            | "SHOW"
            | "EXPLAIN"
            | "INSERT"
            | "UPDATE"
            | "DELETE"
    ) {
        column_types(client, sql).await
    } else {
        Vec::new()
    };
    let outcome = match collect(client, sql).await {
        Ok((Some(names), rows, total_rows)) => Outcome::Rows {
            columns: names
                .into_iter()
                .enumerate()
                .map(|(i, name)| ResultColumn {
                    name,
                    type_name: types.get(i).cloned().flatten(),
                })
                .collect(),
            rows,
            total_rows,
        },
        Ok((None, _, affected)) => Outcome::Command {
            command: keyword,
            rows_affected: affected,
        },
        Err(error) => Outcome::Error {
            error: error.info(),
        },
    };
    StatementResult {
        sql: sql.to_owned(),
        outcome,
        elapsed_ms: u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX),
    }
}

type Collected = (Option<Vec<String>>, Vec<Vec<Option<String>>>, u64);

async fn collect(client: &Client, sql: &str) -> Result<Collected, Error> {
    let stream = client.simple_query_raw(sql).await?;
    futures_util::pin_mut!(stream);
    let mut columns = None;
    let mut rows = Vec::new();
    let mut count = 0;
    while let Some(message) = stream.next().await {
        match message? {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = Some(cols.iter().map(|c| c.name().to_owned()).collect());
            }
            SimpleQueryMessage::Row(row) => {
                if rows.len() < MAX_RESULT_ROWS {
                    rows.push(
                        (0..row.len())
                            .map(|i| row.get(i).map(str::to_owned))
                            .collect(),
                    );
                }
            }
            SimpleQueryMessage::CommandComplete(n) => count = n,
            _ => {}
        }
    }
    Ok((columns, rows, count))
}

/// Reports whether the session is inside a transaction.
///
/// Inside a transaction `now()` is the transaction's start time, so it differs from
/// `statement_timestamp()`; outside, each statement is its own transaction and they
/// are equal. A failed transaction rejects the query with SQLSTATE 25P02.
pub async fn transaction_status(client: &Client) -> TransactionStatus {
    // The simple protocol sends one message, so outside a transaction both timestamps
    // are taken at the same moment. (The extended protocol parses in a separate round
    // trip, which makes them differ.)
    match client
        .simple_query("SELECT now() <> statement_timestamp()")
        .await
    {
        Ok(messages) => {
            let in_transaction = messages
                .iter()
                .any(|m| matches!(m, SimpleQueryMessage::Row(row) if row.get(0) == Some("t")));
            if in_transaction {
                TransactionStatus::InTransaction
            } else {
                TransactionStatus::Idle
            }
        }
        Err(e) if e.code() == Some(&tokio_postgres::error::SqlState::IN_FAILED_SQL_TRANSACTION) => {
            TransactionStatus::Failed
        }
        Err(_) => TransactionStatus::Idle,
    }
}
