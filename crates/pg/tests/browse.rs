//! Catalog, paging and SQL execution against a real PostgreSQL (testcontainers).
//!
//! Set `PG_IMAGE_TAG` to test another server version. These tests need Docker.

use db_editor_core::filter::{Conjunction, Filter, FilterCondition, FilterOp};
use db_editor_pg::browse::{self, PageCursor, PageRequest, SortKey};
use db_editor_pg::catalog::{self, RelationKind};
use db_editor_pg::exec::{self, Outcome, TransactionStatus};
use db_editor_pg::{ConnectOptions, Session, SslMode, SslOptions};
use testcontainers_modules::postgres::Postgres;
use testcontainers_modules::testcontainers::{ContainerAsync, ImageExt, runners::AsyncRunner};

const SCHEMA: &str = "
CREATE TYPE plan AS ENUM ('free', 'pro');
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL UNIQUE,
  plan plan NOT NULL DEFAULT 'free',
  deleted_at timestamptz
);
COMMENT ON TABLE users IS 'app users';
CREATE TABLE orders (
  id bigint PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users (id),
  total integer NOT NULL CHECK (total >= 0)
);
CREATE INDEX orders_user_id_idx ON orders (user_id);
CREATE VIEW pro_users AS SELECT * FROM users WHERE plan = 'pro';
CREATE FUNCTION add(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b';
INSERT INTO users (email, plan) SELECT 'u' || i || '@example.com', CASE WHEN i % 3 = 0 THEN 'pro' ELSE 'free' END::plan
  FROM generate_series(1, 1200) i;
INSERT INTO orders SELECT i, 1 + i % 10, i * 10 FROM generate_series(1, 50) i;
ANALYZE;
";

async fn start() -> (ContainerAsync<Postgres>, ConnectOptions) {
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
    let session = db_editor_pg::open(&options).await.unwrap();
    session.client().batch_execute(SCHEMA).await.unwrap();
    (container, options)
}

async fn open(options: &ConnectOptions) -> Session {
    db_editor_pg::open(options).await.unwrap()
}

fn no_filter() -> Filter {
    Filter::Conditions {
        conditions: Vec::new(),
    }
}

#[tokio::test]
async fn reads_catalog_pages_and_runs_sql() {
    let (_container, options) = start().await;
    let session = open(&options).await;
    let client = session.client();

    // Schema tree
    let schemas = catalog::schemas(client).await.unwrap();
    let public = schemas.iter().find(|s| s.name == "public").unwrap();
    let users = public.relations.iter().find(|r| r.name == "users").unwrap();
    assert_eq!(users.kind, RelationKind::Table);
    assert_eq!(users.estimated_rows, Some(1200.0));
    assert!(
        public
            .relations
            .iter()
            .any(|r| r.name == "pro_users" && r.kind == RelationKind::View)
    );
    assert!(
        public
            .functions
            .iter()
            .any(|f| f.name == "add" && f.arguments == "a integer, b integer")
    );
    assert!(
        public
            .types
            .iter()
            .any(|t| t.name == "plan" && t.kind == "e")
    );
    assert!(
        catalog::databases(client)
            .await
            .unwrap()
            .contains(&"postgres".to_owned())
    );

    // Structure
    let info = catalog::table_info(client, "public", "orders")
        .await
        .unwrap();
    assert_eq!(info.key_columns, vec!["id"]);
    assert_eq!(info.foreign_keys[0].target_table, "users");
    assert_eq!(info.foreign_keys[0].columns, vec!["user_id"]);
    let users_info = catalog::table_info(client, "public", "users")
        .await
        .unwrap();
    assert_eq!(users_info.references[0].source_table, "orders");
    assert_eq!(users_info.comment.as_deref(), Some("app users"));
    assert_eq!(users_info.columns[2].type_name, "plan");
    let ddl = catalog::ddl(client, "public", "orders").await.unwrap();
    assert!(ddl.contains("CREATE TABLE \"public\".\"orders\""), "{ddl}");
    assert!(
        ddl.contains("FOREIGN KEY (user_id) REFERENCES users(id)"),
        "{ddl}"
    );
    assert!(ddl.contains("CREATE INDEX orders_user_id_idx"), "{ddl}");
    let view_ddl = catalog::ddl(client, "public", "pro_users").await.unwrap();
    assert!(
        view_ddl.starts_with("CREATE VIEW \"public\".\"pro_users\" AS"),
        "{view_ddl}"
    );

    // Keyset paging over 1200 rows: 500 + 500 + 200
    let mut request = PageRequest {
        schema: "public".into(),
        table: "users".into(),
        filter: no_filter(),
        sort: Vec::new(),
        key_columns: users_info.key_columns.clone(),
        cursor: PageCursor::Start,
    };
    let mut seen = 0;
    let mut pages = 0;
    loop {
        let page = browse::fetch_page(client, &request).await.unwrap();
        assert_eq!(page.columns, vec!["id", "email", "plan", "deleted_at"]);
        seen += page.rows.len();
        pages += 1;
        match page.next {
            Some(next) => request.cursor = next,
            None => break,
        }
    }
    assert_eq!((seen, pages), (1200, 3));

    // Filter + custom sort with OFFSET paging
    request.cursor = PageCursor::Start;
    request.filter = Filter::Conditions {
        conditions: vec![FilterCondition {
            column: "plan".into(),
            op: FilterOp::Eq,
            value: "pro".into(),
            conjunction: Conjunction::And,
        }],
    };
    request.sort = vec![SortKey {
        column: "id".into(),
        descending: true,
    }];
    let page = browse::fetch_page(client, &request).await.unwrap();
    assert_eq!(page.rows.len(), 400);
    assert!(page.next.is_none());
    assert_eq!(page.rows[0][1].as_deref(), Some("u1200@example.com"));
    assert_eq!(page.rows[0][3], None);

    // A raw WHERE with an error reports the server message
    request.filter = Filter::Raw {
        sql: "nope = 1".into(),
    };
    let err = browse::fetch_page(client, &request).await.unwrap_err();
    assert_eq!(err.info().code.as_deref(), Some("42703"));

    // Reverse references
    let count = browse::count_matching(
        client,
        "public",
        "orders",
        &["user_id".into()],
        &[Some("1".into())],
        1000,
    )
    .await
    .unwrap();
    assert_eq!(count, 5);

    // SQL editor: results, types, commands, errors, transactions
    let results = exec::run(
        client,
        &[
            "SELECT id, email FROM users ORDER BY id LIMIT 2".into(),
            "BEGIN".into(),
            "UPDATE orders SET total = total + 1 WHERE user_id = 1".into(),
        ],
    )
    .await;
    match &results[0].outcome {
        Outcome::Rows { columns, rows, .. } => {
            assert_eq!(columns[0].type_name.as_deref(), Some("int8"));
            assert_eq!(rows.len(), 2);
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(
        results[2].outcome,
        Outcome::Command {
            command: "UPDATE".into(),
            rows_affected: 5
        }
    );
    assert_eq!(
        exec::transaction_status(client).await,
        TransactionStatus::InTransaction
    );
    let results = exec::run(client, &["SELECT nope".into(), "SELECT 1".into()]).await;
    assert_eq!(results.len(), 1, "execution stops at the first error");
    assert!(matches!(results[0].outcome, Outcome::Error { .. }));
    assert_eq!(
        exec::transaction_status(client).await,
        TransactionStatus::Failed
    );
    exec::run(client, &["ROLLBACK".into()]).await;
    assert_eq!(
        exec::transaction_status(client).await,
        TransactionStatus::Idle
    );
}

#[tokio::test]
async fn read_only_sessions_reject_writes() {
    let (_container, mut options) = start().await;
    options.read_only = true;
    let session = open(&options).await;
    let results = exec::run(session.client(), &["DELETE FROM orders".into()]).await;
    match &results[0].outcome {
        Outcome::Error { error } => assert_eq!(error.code.as_deref(), Some("25006")),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn cancels_a_running_query() {
    let (_container, options) = start().await;
    let session = std::sync::Arc::new(open(&options).await);
    let running = {
        let session = std::sync::Arc::clone(&session);
        tokio::spawn(
            async move { exec::run(session.client(), &["SELECT pg_sleep(30)".into()]).await },
        )
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    session.cancel().await.unwrap();
    let results = running.await.unwrap();
    match &results[0].outcome {
        Outcome::Error { error } => assert_eq!(error.code.as_deref(), Some("57014")),
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn require_fails_when_the_server_has_no_tls() {
    let (_container, mut options) = start().await;
    // The test image does not enable TLS, so a mode that requires it must fail.
    options.ssl.mode = SslMode::Require;
    assert!(db_editor_pg::open(&options).await.is_err());
}
