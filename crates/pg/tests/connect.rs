//! Integration tests against a real PostgreSQL started with testcontainers.
//!
//! Set `PG_IMAGE_TAG` to test another server version (CI runs a matrix of them).
//! These tests need a running Docker (or compatible) daemon.

use testcontainers_modules::postgres::Postgres;
use testcontainers_modules::testcontainers::{ImageExt, runners::AsyncRunner};

fn image_tag() -> String {
    std::env::var("PG_IMAGE_TAG").unwrap_or_else(|_| "17-alpine".to_owned())
}

#[tokio::test]
async fn connects_and_reads_server_version() {
    let tag = image_tag();
    let container = Postgres::default().with_tag(&tag).start().await.unwrap();
    let port = container.get_host_port_ipv4(5432).await.unwrap();
    let host = container.get_host().await.unwrap();

    let client = db_editor_pg::connect(&format!(
        "host={host} port={port} user=postgres password=postgres dbname=postgres"
    ))
    .await
    .unwrap();

    let version = db_editor_pg::server_version_num(&client).await.unwrap();
    // The spec supports PostgreSQL 12 and later.
    assert!(
        version >= 120_000,
        "unexpected server version {version} for tag {tag}"
    );
}
