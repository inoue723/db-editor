//! PostgreSQL access layer.

pub mod browse;
pub mod catalog;
pub mod exec;
pub mod tls;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio_postgres::{CancelToken, Client};
use tokio_postgres_rustls::MakeRustlsConnect;

pub use tls::{SslMode, SslOptions};

/// Errors from the database layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Postgres(#[from] tokio_postgres::Error),
    #[error("{0}")]
    Tls(String),
    #[error("{0}")]
    Invalid(String),
}

/// Details of an error reported by the server, shown in the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    pub message: String,
    /// SQLSTATE such as `42P01`.
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// 1-based character position in the statement.
    pub position: Option<u32>,
}

impl Error {
    /// Splits the error into the fields the UI shows.
    #[must_use]
    pub fn info(&self) -> ErrorInfo {
        if let Self::Postgres(e) = self
            && let Some(db) = e.as_db_error()
        {
            return ErrorInfo {
                message: format!("{}: {}", db.severity(), db.message()),
                code: Some(db.code().code().to_owned()),
                detail: db.detail().map(str::to_owned),
                hint: db.hint().map(str::to_owned),
                position: match db.position() {
                    Some(tokio_postgres::error::ErrorPosition::Original(p)) => Some(*p),
                    _ => None,
                },
            };
        }
        let message = match self {
            // The Display of a non-database error is often just "error connecting to server";
            // the source has the useful part (connection refused, password failed, ...).
            Self::Postgres(e) => {
                std::error::Error::source(e).map_or_else(|| e.to_string(), |s| format!("{e}: {s}"))
            }
            other => other.to_string(),
        };
        ErrorInfo {
            message,
            code: None,
            detail: None,
            hint: None,
            position: None,
        }
    }
}

/// Everything needed to open a connection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConnectOptions {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: String,
    pub ssl: SslOptions,
    /// Sets `default_transaction_read_only`, so the server rejects writes.
    pub read_only: bool,
    pub application_name: String,
}

/// An open connection.
pub struct Session {
    client: Client,
    cancel: CancelToken,
    tls: MakeRustlsConnect,
}

impl Session {
    /// The underlying client.
    #[must_use]
    pub fn client(&self) -> &Client {
        &self.client
    }

    /// Asks the server to cancel the query running on this session.
    ///
    /// # Errors
    ///
    /// Returns an error when the cancel request cannot be sent.
    pub async fn cancel(&self) -> Result<(), Error> {
        self.cancel.cancel_query(self.tls.clone()).await?;
        Ok(())
    }

    /// Whether the connection has been closed (server restart, network loss).
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.client.is_closed()
    }
}

/// Connects and drives the connection on a background task.
///
/// # Errors
///
/// Returns an error when TLS cannot be set up or the connection fails.
pub async fn open(options: &ConnectOptions) -> Result<Session, Error> {
    let tls = tls::connector(&options.ssl)?;
    let mut config = tokio_postgres::Config::new();
    config
        .host(&options.host)
        .port(options.port)
        .user(&options.user)
        .dbname(&options.database)
        .ssl_mode(options.ssl.mode.to_postgres())
        .connect_timeout(Duration::from_secs(15))
        .keepalives(true)
        .keepalives_idle(Duration::from_secs(60));
    if !options.application_name.is_empty() {
        config.application_name(&options.application_name);
    }
    if let Some(password) = &options.password {
        config.password(password);
    }
    if options.read_only {
        config.options("-c default_transaction_read_only=on");
    }
    let (client, connection) = config.connect(tls.clone()).await?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::warn!(%error, "postgres connection closed with an error");
        }
    });
    let cancel = client.cancel_token();
    Ok(Session {
        client,
        cancel,
        tls,
    })
}

/// Connects with a libpq-style connection string and no TLS.
///
/// # Errors
///
/// Returns an error when the connection cannot be established.
pub async fn connect(config: &str) -> Result<Client, Error> {
    let (client, connection) = tokio_postgres::connect(config, tokio_postgres::NoTls).await?;
    tokio::spawn(async move {
        if let Err(error) = connection.await {
            tracing::warn!(%error, "postgres connection closed with an error");
        }
    });
    Ok(client)
}

/// Returns the server version as a number, for example `170002` for 17.2.
///
/// # Errors
///
/// Returns an error when the query fails or the value cannot be parsed.
pub async fn server_version_num(client: &Client) -> Result<i32, Error> {
    let row = client
        .query_one("SELECT current_setting('server_version_num')::int", &[])
        .await?;
    Ok(row.try_get(0)?)
}

/// Returns the server version as shown to users, for example `17.2`.
///
/// # Errors
///
/// Returns an error when the query fails.
pub async fn server_version(client: &Client) -> Result<String, Error> {
    let row = client
        .query_one("SELECT current_setting('server_version')", &[])
        .await?;
    let full: String = row.try_get(0)?;
    // Debian builds report "16.4 (Debian 16.4-1.pgdg120+1)".
    Ok(full.split_whitespace().next().unwrap_or(&full).to_owned())
}
