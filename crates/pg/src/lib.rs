//! PostgreSQL access layer.

use tokio_postgres::{Client, NoTls};

/// Errors from the database layer.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Postgres(#[from] tokio_postgres::Error),
}

/// Connects without TLS and drives the connection on a background task.
///
/// TLS, SSH tunnels and credential storage come later; this is the minimal entry point.
///
/// # Errors
///
/// Returns an error when the connection cannot be established.
pub async fn connect(config: &str) -> Result<Client, Error> {
    let (client, connection) = tokio_postgres::connect(config, NoTls).await?;
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
