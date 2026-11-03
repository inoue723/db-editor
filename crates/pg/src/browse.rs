//! Reads table contents one page at a time.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, SimpleQueryMessage};

use db_editor_core::filter::{Filter, where_clause};
use db_editor_core::sql::{quote_ident, quote_literal, quote_qualified};

use crate::Error;

/// Rows per page, as in the spec (3.4).
pub const PAGE_SIZE: u32 = 500;

/// One `ORDER BY` key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SortKey {
    pub column: String,
    pub descending: bool,
}

/// Where the next page starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PageCursor {
    /// The first page.
    Start,
    /// Rows whose key is greater than these values (keyset paging).
    After { key: Vec<String> },
    /// Skip this many rows (when the table has no key or a custom sort is used).
    Offset {
        #[specta(type = u32)]
        offset: u64,
    },
}

/// A request for one page of a table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub schema: String,
    pub table: String,
    pub filter: Filter,
    pub sort: Vec<SortKey>,
    /// Columns that identify a row; used for keyset paging and as a tie-breaker.
    pub key_columns: Vec<String>,
    pub cursor: PageCursor,
}

/// A page of rows. Values are PostgreSQL's text output; `None` is NULL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Where the next page starts, or `None` at the end of the table.
    pub next: Option<PageCursor>,
    pub elapsed_ms: u32,
    /// The query that produced the page, for display.
    pub sql: String,
}

/// Uses keyset paging when the rows are in key order (no custom sort), and
/// `OFFSET` otherwise.
fn keyset(request: &PageRequest) -> bool {
    request.sort.is_empty() && !request.key_columns.is_empty()
}

/// Builds the `SELECT` for a page.
#[must_use]
pub fn page_sql(request: &PageRequest) -> String {
    let mut conditions = Vec::new();
    if let Some(filter) = where_clause(&request.filter) {
        conditions.push(filter);
    }
    if let PageCursor::After { key } = &request.cursor
        && keyset(request)
        && key.len() == request.key_columns.len()
    {
        let cols = request
            .key_columns
            .iter()
            .map(|c| quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let vals = key
            .iter()
            .map(|v| quote_literal(v))
            .collect::<Vec<_>>()
            .join(", ");
        conditions.push(format!("({cols}) > ({vals})"));
    }

    let mut order: Vec<String> = request
        .sort
        .iter()
        .map(|s| {
            format!(
                "{} {}",
                quote_ident(&s.column),
                if s.descending { "DESC" } else { "ASC" }
            )
        })
        .collect();
    for key in &request.key_columns {
        if !request.sort.iter().any(|s| &s.column == key) {
            order.push(quote_ident(key));
        }
    }

    let mut sql = format!(
        "SELECT * FROM {}",
        quote_qualified(&request.schema, &request.table)
    );
    if !conditions.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&conditions.join(" AND "));
    }
    if !order.is_empty() {
        sql.push_str(" ORDER BY ");
        sql.push_str(&order.join(", "));
    }
    // One extra row tells whether there is a next page.
    sql.push_str(&format!(" LIMIT {}", PAGE_SIZE + 1));
    if let PageCursor::Offset { offset } = request.cursor
        && offset > 0
    {
        sql.push_str(&format!(" OFFSET {offset}"));
    }
    sql
}

/// Fetches one page.
///
/// # Errors
///
/// Returns an error when the query fails, for example because of an invalid raw filter.
pub async fn fetch_page(client: &Client, request: &PageRequest) -> Result<Page, Error> {
    let sql = page_sql(request);
    let started = Instant::now();
    let messages = client.simple_query(&sql).await?;
    let elapsed_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);

    let mut columns = Vec::new();
    let mut rows = Vec::new();
    for message in messages {
        match message {
            SimpleQueryMessage::RowDescription(cols) => {
                columns = cols.iter().map(|c| c.name().to_owned()).collect();
            }
            SimpleQueryMessage::Row(row) => {
                rows.push(
                    (0..row.len())
                        .map(|i| row.get(i).map(str::to_owned))
                        .collect::<Vec<_>>(),
                );
            }
            _ => {}
        }
    }

    let has_more = rows.len() > PAGE_SIZE as usize;
    rows.truncate(PAGE_SIZE as usize);
    let next = has_more.then(|| next_cursor(request, &columns, &rows));
    Ok(Page {
        columns,
        rows,
        next,
        elapsed_ms,
        sql,
    })
}

fn next_cursor(
    request: &PageRequest,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> PageCursor {
    if keyset(request)
        && let Some(last) = rows.last()
    {
        let key: Option<Vec<String>> = request
            .key_columns
            .iter()
            .map(|k| {
                columns
                    .iter()
                    .position(|c| c == k)
                    .and_then(|i| last.get(i).cloned().flatten())
            })
            .collect();
        if let Some(key) = key {
            return PageCursor::After { key };
        }
    }
    let previous = match request.cursor {
        PageCursor::Offset { offset } => offset,
        _ => 0,
    };
    PageCursor::Offset {
        offset: previous + rows.len() as u64,
    }
}

/// Counts rows of `schema.table` whose `columns` equal `values`, stopping at `limit + 1`
/// so that a large table is never scanned in full.
///
/// # Errors
///
/// Returns an error when the query fails.
pub async fn count_matching(
    client: &Client,
    schema: &str,
    table: &str,
    columns: &[String],
    values: &[Option<String>],
    limit: u32,
) -> Result<u64, Error> {
    let condition = columns
        .iter()
        .zip(values)
        .map(|(c, v)| match v {
            Some(v) => format!("{} = {}", quote_ident(c), quote_literal(v)),
            None => "false".to_owned(),
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    let sql = format!(
        "SELECT count(*) FROM (SELECT 1 FROM {} WHERE {condition} LIMIT {}) AS matches",
        quote_qualified(schema, table),
        u64::from(limit) + 1
    );
    let messages = client.simple_query(&sql).await?;
    for message in messages {
        if let SimpleQueryMessage::Row(row) = message {
            return Ok(row.get(0).and_then(|v| v.parse().ok()).unwrap_or(0));
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use db_editor_core::filter::{Conjunction, FilterCondition, FilterOp};

    fn request() -> PageRequest {
        PageRequest {
            schema: "public".into(),
            table: "users".into(),
            filter: Filter::Conditions {
                conditions: Vec::new(),
            },
            sort: Vec::new(),
            key_columns: vec!["id".into()],
            cursor: PageCursor::Start,
        }
    }

    #[test]
    fn first_page_orders_by_key() {
        assert_eq!(
            page_sql(&request()),
            "SELECT * FROM \"public\".\"users\" ORDER BY \"id\" LIMIT 501"
        );
    }

    #[test]
    fn keyset_page_continues_after_the_last_key() {
        let mut r = request();
        r.cursor = PageCursor::After {
            key: vec!["500".into()],
        };
        r.filter = Filter::Conditions {
            conditions: vec![FilterCondition {
                column: "plan".into(),
                op: FilterOp::Eq,
                value: "pro".into(),
                conjunction: Conjunction::And,
            }],
        };
        assert_eq!(
            page_sql(&r),
            "SELECT * FROM \"public\".\"users\" WHERE (\"plan\" = 'pro') AND (\"id\") > ('500') \
             ORDER BY \"id\" LIMIT 501"
        );
    }

    #[test]
    fn custom_sort_uses_offset_with_key_tiebreaker() {
        let mut r = request();
        r.sort = vec![SortKey {
            column: "created_at".into(),
            descending: true,
        }];
        r.cursor = PageCursor::Offset { offset: 500 };
        assert_eq!(
            page_sql(&r),
            "SELECT * FROM \"public\".\"users\" ORDER BY \"created_at\" DESC, \"id\" LIMIT 501 OFFSET 500"
        );
    }

    #[test]
    fn next_cursor_uses_the_last_key() {
        let r = request();
        let columns = vec!["id".to_owned(), "name".to_owned()];
        let rows = vec![vec![Some("7".to_owned()), None]];
        assert_eq!(
            next_cursor(&r, &columns, &rows),
            PageCursor::After {
                key: vec!["7".into()]
            }
        );
        let mut no_key = request();
        no_key.key_columns.clear();
        assert_eq!(
            next_cursor(&no_key, &columns, &rows),
            PageCursor::Offset { offset: 1 }
        );
    }
}
