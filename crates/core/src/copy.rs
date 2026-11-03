//! Text formats offered by "copy" and "copy as" on a grid selection.

use serde::{Deserialize, Serialize};

use crate::sql::{quote_ident, quote_literal, quote_qualified};
use crate::tsv;

/// Output format of a copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum CopyFormat {
    /// Tab-separated values without a header (the plain ⌘C).
    Tsv,
    /// Tab-separated values with a header row (⌘⇧C).
    TsvWithHeader,
    Csv,
    /// An array of objects keyed by column name.
    Json,
    Markdown,
    /// One `INSERT` statement per row.
    Insert,
    /// One `UPDATE ... WHERE <key>` statement per row.
    Update,
    /// `key IN (...)` for the selected rows.
    Where,
}

/// A column of the copied selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyColumn {
    pub name: String,
    /// Type as shown by `format_type`, for example `bigint` or `character varying(20)`.
    pub type_name: String,
}

/// Table the rows came from, when known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyTable {
    pub schema: String,
    pub name: String,
    /// Primary key (or unique key) columns, used by `Update` and `Where`.
    pub key_columns: Vec<CopyColumn>,
}

/// Everything needed to render a selection in any [`CopyFormat`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CopyRequest {
    pub format: CopyFormat,
    pub columns: Vec<CopyColumn>,
    /// Selected values; `None` is SQL NULL.
    pub rows: Vec<Vec<Option<String>>>,
    pub table: Option<CopyTable>,
    /// Key values of each selected row, in the order of `table.key_columns`.
    pub key_values: Vec<Vec<Option<String>>>,
}

/// Errors for formats that need information the selection does not have.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CopyError {
    #[error("this format needs a table with a primary key")]
    NoKey,
}

/// Renders the selection.
///
/// # Errors
///
/// [`CopyError::NoKey`] for `Update` and `Where` when the rows have no table key.
pub fn render(request: &CopyRequest) -> Result<String, CopyError> {
    let names: Vec<&str> = request.columns.iter().map(|c| c.name.as_str()).collect();
    let text = |v: &Option<String>| v.clone().unwrap_or_default();
    Ok(match request.format {
        CopyFormat::Tsv => tsv::encode(request.rows.iter().map(|r| r.iter().map(text))),
        CopyFormat::TsvWithHeader => {
            let header = names.iter().map(|n| (*n).to_owned()).collect::<Vec<_>>();
            tsv::encode(
                std::iter::once(header).chain(
                    request
                        .rows
                        .iter()
                        .map(|r| r.iter().map(text).collect::<Vec<_>>()),
                ),
            )
        }
        CopyFormat::Csv => csv(&names, &request.rows),
        CopyFormat::Json => json(&request.columns, &request.rows),
        CopyFormat::Markdown => markdown(&names, &request.rows),
        CopyFormat::Insert => insert(request),
        CopyFormat::Update => update(request)?,
        CopyFormat::Where => where_in(request)?,
    })
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn csv(names: &[&str], rows: &[Vec<Option<String>>]) -> String {
    let mut out = names
        .iter()
        .map(|n| csv_cell(n))
        .collect::<Vec<_>>()
        .join(",");
    out.push('\n');
    for row in rows {
        let line = row
            .iter()
            .map(|v| csv_cell(v.as_deref().unwrap_or("")))
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn is_numeric_type(type_name: &str) -> bool {
    let base = type_name.split('(').next().unwrap_or("").trim();
    matches!(
        base,
        "smallint"
            | "integer"
            | "bigint"
            | "numeric"
            | "decimal"
            | "real"
            | "double precision"
            | "int2"
            | "int4"
            | "int8"
            | "float4"
            | "float8"
            | "oid"
    )
}

fn is_bool_type(type_name: &str) -> bool {
    matches!(type_name, "boolean" | "bool")
}

fn is_json_type(type_name: &str) -> bool {
    matches!(type_name, "json" | "jsonb")
}

fn json_value(column: &CopyColumn, value: Option<&String>) -> serde_json::Value {
    let Some(v) = value else {
        return serde_json::Value::Null;
    };
    let t = column.type_name.as_str();
    if is_json_type(t)
        && let Ok(parsed) = serde_json::from_str(v)
    {
        return parsed;
    }
    if is_bool_type(t) {
        return serde_json::Value::Bool(v == "t" || v == "true");
    }
    if is_numeric_type(t)
        && let Ok(n) = v.parse::<serde_json::Number>()
    {
        return serde_json::Value::Number(n);
    }
    serde_json::Value::String(v.clone())
}

fn json(columns: &[CopyColumn], rows: &[Vec<Option<String>>]) -> String {
    let array: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            let object = columns
                .iter()
                .zip(row)
                .map(|(c, v)| (c.name.clone(), json_value(c, v.as_ref())))
                .collect::<serde_json::Map<_, _>>();
            serde_json::Value::Object(object)
        })
        .collect();
    let mut out = serde_json::to_string_pretty(&array).unwrap_or_default();
    out.push('\n');
    out
}

fn markdown_cell(value: Option<&str>) -> String {
    value.map_or_else(
        || "NULL".to_owned(),
        |v| {
            v.replace('|', "\\|")
                .replace("\r\n", "<br>")
                .replace('\n', "<br>")
        },
    )
}

fn markdown(names: &[&str], rows: &[Vec<Option<String>>]) -> String {
    let mut out = format!(
        "| {} |\n|{}|\n",
        names
            .iter()
            .map(|n| markdown_cell(Some(n)))
            .collect::<Vec<_>>()
            .join(" | "),
        names.iter().map(|_| " --- ").collect::<Vec<_>>().join("|")
    );
    for row in rows {
        out.push_str("| ");
        out.push_str(
            &row.iter()
                .map(|v| markdown_cell(v.as_deref()))
                .collect::<Vec<_>>()
                .join(" | "),
        );
        out.push_str(" |\n");
    }
    out
}

fn sql_value(column: &CopyColumn, value: Option<&String>) -> String {
    match value {
        None => "NULL".to_owned(),
        Some(v) if is_numeric_type(&column.type_name) && v.parse::<f64>().is_ok() => v.clone(),
        Some(v) if is_bool_type(&column.type_name) => {
            if v == "t" || v == "true" {
                "true".to_owned()
            } else {
                "false".to_owned()
            }
        }
        Some(v) => quote_literal(v),
    }
}

fn table_name(request: &CopyRequest) -> String {
    request.table.as_ref().map_or_else(
        || quote_ident("table_name"),
        |t| quote_qualified(&t.schema, &t.name),
    )
}

fn insert(request: &CopyRequest) -> String {
    let table = table_name(request);
    let cols = request
        .columns
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    request
        .rows
        .iter()
        .map(|row| {
            let values = request
                .columns
                .iter()
                .zip(row)
                .map(|(c, v)| sql_value(c, v.as_ref()))
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {table} ({cols}) VALUES ({values});\n")
        })
        .collect()
}

fn key_condition(table: &CopyTable, key: &[Option<String>]) -> String {
    table
        .key_columns
        .iter()
        .zip(key)
        .map(|(c, v)| match v {
            Some(_) => format!("{} = {}", quote_ident(&c.name), sql_value(c, v.as_ref())),
            None => format!("{} IS NULL", quote_ident(&c.name)),
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

fn keyed_table(request: &CopyRequest) -> Result<&CopyTable, CopyError> {
    match &request.table {
        Some(t) if !t.key_columns.is_empty() && request.key_values.len() == request.rows.len() => {
            Ok(t)
        }
        _ => Err(CopyError::NoKey),
    }
}

fn update(request: &CopyRequest) -> Result<String, CopyError> {
    let table = keyed_table(request)?;
    let name = table_name(request);
    let is_key = |c: &CopyColumn| table.key_columns.iter().any(|k| k.name == c.name);
    Ok(request
        .rows
        .iter()
        .zip(&request.key_values)
        .map(|(row, key)| {
            let sets: Vec<String> = request
                .columns
                .iter()
                .zip(row)
                .filter(|(c, _)| !is_key(c))
                .map(|(c, v)| format!("{} = {}", quote_ident(&c.name), sql_value(c, v.as_ref())))
                .collect();
            if sets.is_empty() {
                format!(
                    "-- No non-key columns selected\nSELECT * FROM {name} WHERE {};\n",
                    key_condition(table, key)
                )
            } else {
                format!(
                    "UPDATE {name} SET {} WHERE {};\n",
                    sets.join(", "),
                    key_condition(table, key)
                )
            }
        })
        .collect())
}

fn where_in(request: &CopyRequest) -> Result<String, CopyError> {
    let table = keyed_table(request)?;
    if let [column] = table.key_columns.as_slice() {
        let values = request
            .key_values
            .iter()
            .map(|k| sql_value(column, k.first().and_then(Option::as_ref)))
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("{} IN ({values})", quote_ident(&column.name)))
    } else {
        let cols = table
            .key_columns
            .iter()
            .map(|c| quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let tuples = request
            .key_values
            .iter()
            .map(|k| {
                let vals = table
                    .key_columns
                    .iter()
                    .zip(k)
                    .map(|(c, v)| sql_value(c, v.as_ref()))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({vals})")
            })
            .collect::<Vec<_>>()
            .join(", ");
        Ok(format!("({cols}) IN ({tuples})"))
    }
}
