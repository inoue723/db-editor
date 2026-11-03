//! Builds the `WHERE` clause for the table filter bar.

use serde::{Deserialize, Serialize};

use crate::sql::{quote_ident, quote_literal};

/// Comparison offered in the filter bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    NotEq,
    Lt,
    Gt,
    /// Case-insensitive substring match.
    Contains,
    /// Case-insensitive prefix match.
    StartsWith,
    /// `ILIKE` with the pattern as typed (`%` and `_` are wildcards).
    ILike,
    /// Comma-separated list of values.
    In,
    IsNull,
    IsNotNull,
}

/// How a condition joins the conditions before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Conjunction {
    And,
    Or,
}

/// One row of the filter bar: `column op value`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FilterCondition {
    pub column: String,
    pub op: FilterOp,
    pub value: String,
    /// Ignored on the first condition.
    pub conjunction: Conjunction,
}

/// What the filter bar sends: structured conditions or a raw `WHERE` expression.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Filter {
    Conditions { conditions: Vec<FilterCondition> },
    Raw { sql: String },
}

/// Returns the boolean expression for a filter (without the `WHERE` keyword), or
/// `None` when nothing should be filtered.
///
/// Values are compared as text against `column::text` for `Contains`, `StartsWith`
/// and `ILike`, so they also work on numbers, dates and enums. The other comparisons
/// pass the value as an untyped literal, which PostgreSQL casts to the column type.
#[must_use]
pub fn where_clause(filter: &Filter) -> Option<String> {
    match filter {
        Filter::Raw { sql } => {
            let sql = sql.trim();
            (!sql.is_empty()).then(|| format!("({sql})"))
        }
        Filter::Conditions { conditions } => {
            let mut out = String::new();
            for condition in conditions.iter().filter(|c| !c.column.is_empty()) {
                if !out.is_empty() {
                    out.push_str(match condition.conjunction {
                        Conjunction::And => " AND ",
                        Conjunction::Or => " OR ",
                    });
                }
                out.push_str(&condition_sql(condition));
            }
            (!out.is_empty()).then(|| format!("({out})"))
        }
    }
}

fn condition_sql(c: &FilterCondition) -> String {
    let col = quote_ident(&c.column);
    let v = &c.value;
    match c.op {
        FilterOp::Eq => format!("{col} = {}", quote_literal(v)),
        FilterOp::NotEq => format!("{col} IS DISTINCT FROM {}", quote_literal(v)),
        FilterOp::Lt => format!("{col} < {}", quote_literal(v)),
        FilterOp::Gt => format!("{col} > {}", quote_literal(v)),
        FilterOp::Contains => format!(
            "{col}::text ILIKE {}",
            quote_literal(&format!("%{}%", escape_like(v)))
        ),
        FilterOp::StartsWith => format!(
            "{col}::text ILIKE {}",
            quote_literal(&format!("{}%", escape_like(v)))
        ),
        FilterOp::ILike => format!("{col}::text ILIKE {}", quote_literal(v)),
        FilterOp::In => {
            let items: Vec<String> = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(quote_literal)
                .collect();
            if items.is_empty() {
                "false".to_owned()
            } else {
                format!("{col} IN ({})", items.join(", "))
            }
        }
        FilterOp::IsNull => format!("{col} IS NULL"),
        FilterOp::IsNotNull => format!("{col} IS NOT NULL"),
    }
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cond(column: &str, op: FilterOp, value: &str, conjunction: Conjunction) -> FilterCondition {
        FilterCondition {
            column: column.to_owned(),
            op,
            value: value.to_owned(),
            conjunction,
        }
    }

    #[test]
    fn empty_filters_produce_nothing() {
        assert_eq!(where_clause(&Filter::Raw { sql: "  ".into() }), None);
        assert_eq!(
            where_clause(&Filter::Conditions {
                conditions: vec![cond("", FilterOp::Eq, "x", Conjunction::And)]
            }),
            None
        );
    }

    #[test]
    fn conditions_are_joined_and_quoted() {
        let filter = Filter::Conditions {
            conditions: vec![
                cond("plan", FilterOp::NotEq, "free", Conjunction::And),
                cond("deleted_at", FilterOp::IsNull, "", Conjunction::And),
                cond("name", FilterOp::Contains, "o'n_1%", Conjunction::Or),
                cond("id", FilterOp::In, "1, 2,,3", Conjunction::And),
            ],
        };
        assert_eq!(
            where_clause(&filter).unwrap(),
            "(\"plan\" IS DISTINCT FROM 'free' AND \"deleted_at\" IS NULL \
             OR \"name\"::text ILIKE '%o''n\\_1\\%%' AND \"id\" IN ('1', '2', '3'))"
        );
    }

    #[test]
    fn raw_where_is_parenthesized() {
        assert_eq!(
            where_clause(&Filter::Raw {
                sql: "a = 1 or b = 2".into()
            })
            .unwrap(),
            "(a = 1 or b = 2)"
        );
    }

    #[test]
    fn empty_in_list_matches_nothing() {
        let filter = Filter::Conditions {
            conditions: vec![cond("id", FilterOp::In, " , ", Conjunction::And)],
        };
        assert_eq!(where_clause(&filter).unwrap(), "(false)");
    }
}
