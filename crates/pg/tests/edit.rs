//! Saving row changes against a real PostgreSQL (testcontainers). Needs Docker.
#![allow(clippy::unwrap_used)]

use db_editor_core::edit::{CellValue, ChangeSet, ColumnValue, RowChange};
use db_editor_pg::catalog;
use db_editor_pg::edit::{SaveOutcome, apply};
use db_editor_pg::{ConnectOptions, SslMode, SslOptions};
use testcontainers_modules::postgres::Postgres;
use testcontainers_modules::testcontainers::{ImageExt, runners::AsyncRunner};

const SCHEMA: &str = "
CREATE TYPE plan AS ENUM ('free', 'pro');
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  plan plan NOT NULL DEFAULT 'free',
  email_upper text GENERATED ALWAYS AS (upper(email)) STORED,
  note text
);
INSERT INTO users (email) VALUES ('a@example.com'), ('b@example.com');
CREATE TABLE tags (name text PRIMARY KEY, color text);
";

fn value(column: &str, text: &str) -> ColumnValue {
    ColumnValue {
        column: column.into(),
        value: CellValue::Value { text: text.into() },
    }
}

fn users(changes: Vec<RowChange>) -> ChangeSet {
    ChangeSet {
        schema: "public".into(),
        table: "users".into(),
        key_columns: vec!["id".into()],
        changes,
    }
}

async fn emails(client: &tokio_postgres::Client) -> Vec<String> {
    client
        .query("SELECT email FROM users ORDER BY email", &[])
        .await
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect()
}

#[tokio::test]
async fn saves_changes_in_one_transaction() {
    let tag = std::env::var("PG_IMAGE_TAG").unwrap_or_else(|_| "17-alpine".to_owned());
    let container = Postgres::default().with_tag(tag).start().await.unwrap();
    let options = ConnectOptions {
        host: container.get_host().await.unwrap().to_string(),
        port: container.get_host_port_ipv4(5432).await.unwrap(),
        user: "postgres".into(),
        password: Some("postgres".into()),
        database: "postgres".into(),
        ssl: SslOptions {
            mode: SslMode::Prefer,
            ..SslOptions::default()
        },
        read_only: false,
        application_name: "db-editor-test".into(),
    };
    let mut session = db_editor_pg::open(&options).await.unwrap();
    session.client().batch_execute(SCHEMA).await.unwrap();

    // The catalog tells which columns the editor must leave alone.
    let info = catalog::table_info(session.client(), "public", "users")
        .await
        .unwrap();
    let col = |n: &str| info.columns.iter().find(|c| c.name == n).unwrap();
    assert!(col("id").identity);
    assert!(col("email_upper").generated);
    assert_eq!(col("plan").enum_values, vec!["free", "pro"]);
    assert!(col("note").enum_values.is_empty());

    // Update, insert (identity and generated columns left to the server) and delete.
    let outcome = apply(
        session.client_mut(),
        &users(vec![
            RowChange::Update {
                key: vec![Some("1".into())],
                values: vec![
                    value("plan", "pro"),
                    ColumnValue {
                        column: "note".into(),
                        value: CellValue::Null,
                    },
                ],
            },
            RowChange::Insert {
                values: vec![
                    ColumnValue {
                        column: "id".into(),
                        value: CellValue::Default,
                    },
                    value("email", "c@example.com"),
                ],
                upsert: false,
            },
            RowChange::Delete {
                key: vec![Some("2".into())],
            },
        ]),
    )
    .await
    .unwrap();
    let SaveOutcome::Saved(saved) = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(saved.columns[..3], ["id", "email", "plan"]);
    assert_eq!(saved.rows[0].as_ref().unwrap()[2].as_deref(), Some("pro"));
    let inserted = saved.rows[1].as_ref().unwrap();
    assert_eq!(inserted[0].as_deref(), Some("3"));
    assert_eq!(inserted[3].as_deref(), Some("C@EXAMPLE.COM"));
    assert_eq!(saved.rows[2], None);
    assert_eq!(
        emails(session.client()).await,
        ["a@example.com", "c@example.com"]
    );

    // A failing change rolls back the earlier ones and names the change.
    let outcome = apply(
        session.client_mut(),
        &users(vec![
            RowChange::Update {
                key: vec![Some("1".into())],
                values: vec![value("email", "z@example.com")],
            },
            RowChange::Update {
                key: vec![Some("3".into())],
                values: vec![value("plan", "gold")],
            },
        ]),
    )
    .await
    .unwrap();
    let SaveOutcome::Failed { index, error } = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(index, Some(1));
    assert_eq!(error.code.as_deref(), Some("22P02"), "{error:?}");
    assert_eq!(
        emails(session.client()).await,
        ["a@example.com", "c@example.com"]
    );

    // A row deleted by someone else is reported instead of silently skipped.
    let outcome = apply(
        session.client_mut(),
        &users(vec![RowChange::Delete {
            key: vec![Some("2".into())],
        }]),
    )
    .await
    .unwrap();
    assert!(
        matches!(outcome, SaveOutcome::Failed { index: Some(0), .. }),
        "{outcome:?}"
    );

    // Upsert by key: update the existing row, insert the new one.
    let outcome = apply(
        session.client_mut(),
        &ChangeSet {
            schema: "public".into(),
            table: "tags".into(),
            key_columns: vec!["name".into()],
            changes: vec![
                RowChange::Insert {
                    values: vec![value("name", "red"), value("color", "#f00")],
                    upsert: true,
                },
                RowChange::Insert {
                    values: vec![value("name", "red"), value("color", "#e00")],
                    upsert: true,
                },
            ],
        },
    )
    .await
    .unwrap();
    assert!(matches!(outcome, SaveOutcome::Saved(_)), "{outcome:?}");
    let color: String = session
        .client()
        .query_one("SELECT color FROM tags WHERE name = 'red'", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(color, "#e00");
}
