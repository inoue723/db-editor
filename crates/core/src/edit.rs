//! Unsaved row changes and the SQL that applies them (spec 3.5).
//!
//! The grid collects edits as a [`ChangeSet`]. Saving turns every change into one
//! statement and runs them all in one transaction. Rows are identified by their key
//! (primary key, or a unique index on NOT NULL columns); tables without one are
//! opened read-only, so every `UPDATE` and `DELETE` here targets exactly one row.
//!
//! Values are PostgreSQL text input, written as untyped literals so that the server
//! converts them to each column's type (and reports a clear error when it cannot).

use serde::{Deserialize, Serialize};

use crate::sql::{quote_ident, quote_literal, quote_qualified};

/// The new value of a cell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CellValue {
    /// A value in PostgreSQL text format. The empty string is an empty string, not NULL.
    Value {
        text: String,
    },
    Null,
    /// The column default (`DEFAULT`).
    Default,
}

impl CellValue {
    fn sql(&self) -> String {
        match self {
            Self::Value { text } => quote_literal(text),
            Self::Null => "NULL".to_owned(),
            Self::Default => "DEFAULT".to_owned(),
        }
    }
}

/// A column and its new value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ColumnValue {
    pub column: String,
    pub value: CellValue,
}

/// One unsaved change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RowChange {
    /// Changes cells of the row whose key is `key` (values in the order of
    /// [`ChangeSet::key_columns`], as loaded before the edit).
    Update {
        key: Vec<Option<String>>,
        values: Vec<ColumnValue>,
    },
    /// Adds a row. Columns that are not listed get their default.
    Insert {
        values: Vec<ColumnValue>,
        /// Updates the existing row instead when the key already exists
        /// ("paste matching the primary key", spec 4.3).
        upsert: bool,
    },
    Delete {
        key: Vec<Option<String>>,
    },
}

/// The unsaved changes of one table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub schema: String,
    pub table: String,
    /// Columns that identify a row.
    pub key_columns: Vec<String>,
    pub changes: Vec<RowChange>,
}

/// A change that cannot be turned into SQL.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EditError {
    #[error("the table has no primary key or unique key, so rows cannot be changed")]
    NoKey,
    #[error("change {index}: the row key has {got} values but the table key has {expected}")]
    KeyLength {
        index: usize,
        got: usize,
        expected: usize,
    },
    #[error("change {index}: there is nothing to update")]
    Empty { index: usize },
}

fn key_condition(key_columns: &[String], key: &[Option<String>]) -> String {
    key_columns
        .iter()
        .zip(key)
        .map(|(c, v)| match v {
            Some(v) => format!("{} = {}", quote_ident(c), quote_literal(v)),
            None => format!("{} IS NULL", quote_ident(c)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

impl ChangeSet {
    fn check_key(&self, index: usize, key: &[Option<String>]) -> Result<(), EditError> {
        if self.key_columns.is_empty() {
            return Err(EditError::NoKey);
        }
        if key.len() != self.key_columns.len() {
            return Err(EditError::KeyLength {
                index,
                got: key.len(),
                expected: self.key_columns.len(),
            });
        }
        Ok(())
    }

    /// The statement for change number `index`. `UPDATE` and `INSERT` return the stored row
    /// (`RETURNING *`) so the grid can show values the server filled in.
    ///
    /// # Errors
    ///
    /// Returns an [`EditError`] when the table has no key, a key has the wrong length,
    /// or an update changes nothing.
    pub fn statement(&self, index: usize, change: &RowChange) -> Result<String, EditError> {
        let table = quote_qualified(&self.schema, &self.table);
        Ok(match change {
            RowChange::Update { key, values } => {
                self.check_key(index, key)?;
                if values.is_empty() {
                    return Err(EditError::Empty { index });
                }
                let set = values
                    .iter()
                    .map(|v| format!("{} = {}", quote_ident(&v.column), v.value.sql()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "UPDATE {table} SET {set} WHERE {} RETURNING *",
                    key_condition(&self.key_columns, key)
                )
            }
            RowChange::Insert { values, upsert } => {
                if *upsert && self.key_columns.is_empty() {
                    return Err(EditError::NoKey);
                }
                // Columns left at their default are omitted, so `GENERATED ALWAYS`
                // identity columns and generated columns are never written.
                let given: Vec<&ColumnValue> = values
                    .iter()
                    .filter(|v| v.value != CellValue::Default)
                    .collect();
                let mut sql = if given.is_empty() {
                    format!("INSERT INTO {table} DEFAULT VALUES")
                } else {
                    format!(
                        "INSERT INTO {table} ({}) VALUES ({})",
                        given
                            .iter()
                            .map(|v| quote_ident(&v.column))
                            .collect::<Vec<_>>()
                            .join(", "),
                        given
                            .iter()
                            .map(|v| v.value.sql())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                };
                if *upsert {
                    let keys = self
                        .key_columns
                        .iter()
                        .map(|c| quote_ident(c))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let updates: Vec<String> = given
                        .iter()
                        .filter(|v| !self.key_columns.contains(&v.column))
                        .map(|v| {
                            let c = quote_ident(&v.column);
                            format!("{c} = EXCLUDED.{c}")
                        })
                        .collect();
                    if updates.is_empty() {
                        sql.push_str(&format!(" ON CONFLICT ({keys}) DO NOTHING"));
                    } else {
                        sql.push_str(&format!(
                            " ON CONFLICT ({keys}) DO UPDATE SET {}",
                            updates.join(", ")
                        ));
                    }
                }
                sql.push_str(" RETURNING *");
                sql
            }
            RowChange::Delete { key } => {
                self.check_key(index, key)?;
                format!(
                    "DELETE FROM {table} WHERE {}",
                    key_condition(&self.key_columns, key)
                )
            }
        })
    }

    /// Every statement of the change set, in order.
    ///
    /// # Errors
    ///
    /// Returns the first [`EditError`] of [`ChangeSet::statement`].
    pub fn statements(&self) -> Result<Vec<String>, EditError> {
        self.changes
            .iter()
            .enumerate()
            .map(|(i, c)| self.statement(i, c))
            .collect()
    }
}

/// Whether a change must affect exactly one row. `UPDATE` and `DELETE` target one row
/// by its key; zero rows means someone else deleted it or changed its key.
#[must_use]
pub fn expects_one_row(change: &RowChange) -> bool {
    matches!(change, RowChange::Update { .. } | RowChange::Delete { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(column: &str, text: &str) -> ColumnValue {
        ColumnValue {
            column: column.into(),
            value: CellValue::Value { text: text.into() },
        }
    }

    fn set(changes: Vec<RowChange>) -> ChangeSet {
        ChangeSet {
            schema: "public".into(),
            table: "users".into(),
            key_columns: vec!["id".into()],
            changes,
        }
    }

    #[test]
    fn update_sets_values_by_key() {
        let s = set(vec![RowChange::Update {
            key: vec![Some("7".into())],
            values: vec![
                value("name", "O'Brien"),
                ColumnValue {
                    column: "note".into(),
                    value: CellValue::Null,
                },
            ],
        }]);
        assert_eq!(
            s.statements().unwrap(),
            vec![
                "UPDATE \"public\".\"users\" SET \"name\" = 'O''Brien', \"note\" = NULL \
                 WHERE \"id\" = '7' RETURNING *"
            ]
        );
    }

    #[test]
    fn insert_omits_default_columns() {
        let s = set(vec![
            RowChange::Insert {
                values: vec![
                    ColumnValue {
                        column: "id".into(),
                        value: CellValue::Default,
                    },
                    value("name", ""),
                ],
                upsert: false,
            },
            RowChange::Insert {
                values: vec![],
                upsert: false,
            },
        ]);
        assert_eq!(
            s.statements().unwrap(),
            vec![
                "INSERT INTO \"public\".\"users\" (\"name\") VALUES ('') RETURNING *",
                "INSERT INTO \"public\".\"users\" DEFAULT VALUES RETURNING *",
            ]
        );
    }

    #[test]
    fn upsert_updates_non_key_columns() {
        let s = set(vec![
            RowChange::Insert {
                values: vec![value("id", "1"), value("name", "a")],
                upsert: true,
            },
            RowChange::Insert {
                values: vec![value("id", "2")],
                upsert: true,
            },
        ]);
        assert_eq!(
            s.statements().unwrap(),
            vec![
                "INSERT INTO \"public\".\"users\" (\"id\", \"name\") VALUES ('1', 'a') \
                 ON CONFLICT (\"id\") DO UPDATE SET \"name\" = EXCLUDED.\"name\" RETURNING *",
                "INSERT INTO \"public\".\"users\" (\"id\") VALUES ('2') \
                 ON CONFLICT (\"id\") DO NOTHING RETURNING *",
            ]
        );
    }

    #[test]
    fn delete_by_composite_key() {
        let mut s = set(vec![RowChange::Delete {
            key: vec![Some("1".into()), Some("x".into())],
        }]);
        s.key_columns = vec!["a".into(), "b".into()];
        assert_eq!(
            s.statements().unwrap(),
            vec!["DELETE FROM \"public\".\"users\" WHERE \"a\" = '1' AND \"b\" = 'x'"]
        );
    }

    #[test]
    fn rejects_changes_without_a_usable_key() {
        let mut s = set(vec![RowChange::Delete {
            key: vec![Some("1".into())],
        }]);
        s.key_columns.clear();
        assert_eq!(s.statements(), Err(EditError::NoKey));

        let s = set(vec![RowChange::Update {
            key: vec![],
            values: vec![value("a", "b")],
        }]);
        assert_eq!(
            s.statements(),
            Err(EditError::KeyLength {
                index: 0,
                got: 0,
                expected: 1
            })
        );
    }
}
