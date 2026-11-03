//! Reads the schema tree and table structure from the system catalogs.

use serde::{Deserialize, Serialize};
use tokio_postgres::Client;

use db_editor_core::sql::{quote_ident, quote_qualified};

use crate::Error;

/// Kind of a relation shown in the schema tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RelationKind {
    Table,
    PartitionedTable,
    View,
    MaterializedView,
    ForeignTable,
}

impl RelationKind {
    fn from_relkind(relkind: &str) -> Option<Self> {
        Some(match relkind {
            "r" => Self::Table,
            "p" => Self::PartitionedTable,
            "v" => Self::View,
            "m" => Self::MaterializedView,
            "f" => Self::ForeignTable,
            _ => return None,
        })
    }
}

/// A table, view or materialized view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub name: String,
    pub kind: RelationKind,
    /// `pg_class.reltuples`; `None` when the table has never been analyzed.
    pub estimated_rows: Option<f64>,
}

/// A function in the schema tree, with its argument types.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Function {
    pub name: String,
    pub arguments: String,
    /// `f` function, `p` procedure, `a` aggregate, `w` window.
    pub kind: String,
}

/// A user-defined type: enum, domain or composite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UserType {
    pub name: String,
    /// `e` enum, `d` domain, `c` composite.
    pub kind: String,
}

/// One schema with its objects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub name: String,
    pub relations: Vec<Relation>,
    pub functions: Vec<Function>,
    pub types: Vec<UserType>,
}

const HIDDEN_SCHEMAS: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') \
     AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'";

/// Excludes objects that belong to an extension (PostGIS functions and the like).
const NOT_FROM_EXTENSION: &str = "NOT EXISTS (SELECT 1 FROM pg_depend dep \
     WHERE dep.objid = {oid} AND dep.deptype = 'e')";

/// Lists the databases the user can connect to.
///
/// # Errors
///
/// Returns an error when the query fails.
pub async fn databases(client: &Client) -> Result<Vec<String>, Error> {
    let rows = client
        .query(
            "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
            &[],
        )
        .await?;
    rows.iter()
        .map(|r| r.try_get(0).map_err(Error::from))
        .collect()
}

/// Reads every schema with its relations, functions and types.
///
/// # Errors
///
/// Returns an error when a catalog query fails.
pub async fn schemas(client: &Client) -> Result<Vec<Schema>, Error> {
    let schema_rows = client
        .query(
            &format!(
                "SELECT n.nspname FROM pg_namespace n WHERE {HIDDEN_SCHEMAS} \
                 ORDER BY n.nspname <> 'public', n.nspname"
            ),
            &[],
        )
        .await?;
    let mut schemas: Vec<Schema> = schema_rows
        .iter()
        .map(|r| {
            Ok(Schema {
                name: r.try_get(0)?,
                relations: Vec::new(),
                functions: Vec::new(),
                types: Vec::new(),
            })
        })
        .collect::<Result<_, Error>>()?;
    let index_of = |schemas: &[Schema], name: &str| schemas.iter().position(|s| s.name == name);

    let relations = client
        .query(
            &format!(
                "SELECT n.nspname, c.relname, c.relkind::text, c.reltuples::float8 \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition \
                 AND {HIDDEN_SCHEMAS} AND {} ORDER BY c.relname",
                NOT_FROM_EXTENSION.replace("{oid}", "c.oid")
            ),
            &[],
        )
        .await?;
    for row in &relations {
        let schema: String = row.try_get(0)?;
        let relkind: String = row.try_get(2)?;
        let reltuples: f64 = row.try_get(3)?;
        if let (Some(i), Some(kind)) = (
            index_of(&schemas, &schema),
            RelationKind::from_relkind(&relkind),
        ) {
            schemas[i].relations.push(Relation {
                name: row.try_get(1)?,
                kind,
                estimated_rows: (reltuples >= 0.0
                    && matches!(
                        kind,
                        RelationKind::Table
                            | RelationKind::PartitionedTable
                            | RelationKind::MaterializedView
                    ))
                .then_some(reltuples),
            });
        }
    }

    let functions = client
        .query(
            &format!(
                "SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prokind::text \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE {HIDDEN_SCHEMAS} AND {} ORDER BY p.proname, 3",
                NOT_FROM_EXTENSION.replace("{oid}", "p.oid")
            ),
            &[],
        )
        .await?;
    for row in &functions {
        let schema: String = row.try_get(0)?;
        if let Some(i) = index_of(&schemas, &schema) {
            schemas[i].functions.push(Function {
                name: row.try_get(1)?,
                arguments: row.try_get(2)?,
                kind: row.try_get(3)?,
            });
        }
    }

    let types = client
        .query(
            &format!(
                "SELECT n.nspname, t.typname, t.typtype::text \
                 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace \
                 WHERE {HIDDEN_SCHEMAS} AND {} AND (t.typtype IN ('e', 'd') \
                   OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c')) \
                 ORDER BY t.typname",
                NOT_FROM_EXTENSION.replace("{oid}", "t.oid")
            ),
            &[],
        )
        .await?;
    for row in &types {
        let schema: String = row.try_get(0)?;
        if let Some(i) = index_of(&schemas, &schema) {
            schemas[i].types.push(UserType {
                name: row.try_get(1)?,
                kind: row.try_get(2)?,
            });
        }
    }
    Ok(schemas)
}

/// A column of a table or view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub name: String,
    /// As shown by `format_type`, for example `character varying(20)`.
    pub type_name: String,
    /// `pg_type.typcategory`: `N` numeric, `B` boolean, `D` date/time, `U` user (json...), ...
    pub category: String,
    pub not_null: bool,
    pub default: Option<String>,
    pub comment: Option<String>,
    /// An identity column (`GENERATED ... AS IDENTITY`).
    pub identity: bool,
    /// A generated column (`GENERATED ALWAYS AS (...) STORED`), which cannot be written.
    pub generated: bool,
    /// Labels of an enum type, in order; empty for other types.
    pub enum_values: Vec<String>,
}

/// A foreign key from this table to another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub target_schema: String,
    pub target_table: String,
    pub target_columns: Vec<String>,
}

/// A foreign key from another table to this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    pub name: String,
    pub source_schema: String,
    pub source_table: String,
    pub source_columns: Vec<String>,
    /// Columns of this table that the key points to.
    pub columns: Vec<String>,
}

/// An index with its definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub name: String,
    pub definition: String,
    pub primary: bool,
    pub unique: bool,
}

/// A table constraint with its definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Constraint {
    pub name: String,
    /// `p` primary key, `u` unique, `f` foreign key, `c` check, `x` exclusion.
    pub kind: String,
    pub definition: String,
}

/// Structure of a relation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub kind: RelationKind,
    pub comment: Option<String>,
    pub estimated_rows: Option<f64>,
    pub columns: Vec<Column>,
    /// Primary key columns, or the columns of a unique index on NOT NULL columns.
    /// Empty when rows cannot be identified.
    pub key_columns: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
    pub references: Vec<Reference>,
    pub indexes: Vec<Index>,
    pub constraints: Vec<Constraint>,
}

const COLUMN_NAMES: &str = "ARRAY(SELECT a.attname::text FROM unnest({keys}) WITH ORDINALITY k(num, ord) \
     JOIN pg_attribute a ON a.attrelid = {rel} AND a.attnum = k.num ORDER BY k.ord)";

fn column_names(keys: &str, rel: &str) -> String {
    COLUMN_NAMES.replace("{keys}", keys).replace("{rel}", rel)
}

/// Reads the structure of `schema.name`.
///
/// # Errors
///
/// Returns an error when the relation does not exist or a query fails.
pub async fn table_info(client: &Client, schema: &str, name: &str) -> Result<TableInfo, Error> {
    let rel = client
        .query_opt(
            "SELECT c.oid, c.relkind::text, obj_description(c.oid, 'pg_class'), c.reltuples::float8 \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &name],
        )
        .await?
        .ok_or_else(|| Error::Invalid(format!("relation {schema}.{name} does not exist")))?;
    let oid: u32 = rel.try_get(0)?;
    let relkind: String = rel.try_get(1)?;
    let kind = RelationKind::from_relkind(&relkind)
        .ok_or_else(|| Error::Invalid(format!("{schema}.{name} is not a table or view")))?;
    let reltuples: f64 = rel.try_get(3)?;

    let columns = client
        .query(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), t.typcategory::text, a.attnotnull, \
                    pg_get_expr(d.adbin, d.adrelid), col_description(a.attrelid, a.attnum), \
                    a.attidentity <> '', a.attgenerated <> '', \
                    ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = a.atttypid \
                          ORDER BY e.enumsortorder) \
             FROM pg_attribute a \
             JOIN pg_type t ON t.oid = a.atttypid \
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
             WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
            &[&oid],
        )
        .await?
        .iter()
        .map(|r| {
            Ok(Column {
                name: r.try_get(0)?,
                type_name: r.try_get(1)?,
                category: r.try_get(2)?,
                not_null: r.try_get(3)?,
                default: r.try_get(4)?,
                comment: r.try_get(5)?,
                identity: r.try_get(6)?,
                generated: r.try_get(7)?,
                enum_values: r.try_get(8)?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;

    let indexes = client
        .query(
            &format!(
                "SELECT ic.relname, pg_get_indexdef(i.indexrelid), i.indisprimary, i.indisunique, \
                        {}, i.indpred IS NULL AND i.indexprs IS NULL \
                 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid \
                 WHERE i.indrelid = $1 ORDER BY NOT i.indisprimary, ic.relname",
                column_names("i.indkey", "i.indrelid")
            ),
            &[&oid],
        )
        .await?;
    let mut key_columns: Vec<String> = Vec::new();
    let mut index_list = Vec::new();
    for row in &indexes {
        let primary: bool = row.try_get(2)?;
        let unique: bool = row.try_get(3)?;
        let cols: Vec<String> = row.try_get(4)?;
        let plain: bool = row.try_get(5)?;
        let all_not_null = cols
            .iter()
            .all(|c| columns.iter().any(|col| &col.name == c && col.not_null));
        if key_columns.is_empty() && (primary || (unique && plain && all_not_null)) {
            key_columns = cols;
        }
        index_list.push(Index {
            name: row.try_get(0)?,
            definition: row.try_get(1)?,
            primary,
            unique,
        });
    }

    let foreign_keys = client
        .query(
            &format!(
                "SELECT con.conname, {}, fn.nspname, fc.relname, {} \
                 FROM pg_constraint con \
                 JOIN pg_class fc ON fc.oid = con.confrelid \
                 JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
                 WHERE con.conrelid = $1 AND con.contype = 'f' ORDER BY con.conname",
                column_names("con.conkey", "con.conrelid"),
                column_names("con.confkey", "con.confrelid")
            ),
            &[&oid],
        )
        .await?
        .iter()
        .map(|r| {
            Ok(ForeignKey {
                name: r.try_get(0)?,
                columns: r.try_get(1)?,
                target_schema: r.try_get(2)?,
                target_table: r.try_get(3)?,
                target_columns: r.try_get(4)?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;

    let references = client
        .query(
            &format!(
                "SELECT con.conname, sn.nspname, sc.relname, {}, {} \
                 FROM pg_constraint con \
                 JOIN pg_class sc ON sc.oid = con.conrelid \
                 JOIN pg_namespace sn ON sn.oid = sc.relnamespace \
                 WHERE con.confrelid = $1 AND con.contype = 'f' ORDER BY sc.relname, con.conname",
                column_names("con.conkey", "con.conrelid"),
                column_names("con.confkey", "con.confrelid")
            ),
            &[&oid],
        )
        .await?
        .iter()
        .map(|r| {
            Ok(Reference {
                name: r.try_get(0)?,
                source_schema: r.try_get(1)?,
                source_table: r.try_get(2)?,
                source_columns: r.try_get(3)?,
                columns: r.try_get(4)?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;

    let constraints = client
        .query(
            "SELECT conname, contype::text, pg_get_constraintdef(oid, true) FROM pg_constraint \
             WHERE conrelid = $1 ORDER BY array_position(ARRAY['p','u','f','c','x'], contype::text), conname",
            &[&oid],
        )
        .await?
        .iter()
        .map(|r| {
            Ok(Constraint {
                name: r.try_get(0)?,
                kind: r.try_get(1)?,
                definition: r.try_get(2)?,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;

    Ok(TableInfo {
        schema: schema.to_owned(),
        name: name.to_owned(),
        kind,
        comment: rel.try_get(2)?,
        estimated_rows: (reltuples >= 0.0).then_some(reltuples),
        columns,
        key_columns,
        foreign_keys,
        references,
        indexes: index_list,
        constraints,
    })
}

/// Builds the DDL of a relation: `CREATE TABLE` with its constraints, indexes and
/// comments, or `CREATE VIEW` / `CREATE MATERIALIZED VIEW` with its query.
///
/// # Errors
///
/// Returns an error when the relation does not exist or a query fails.
pub async fn ddl(client: &Client, schema: &str, name: &str) -> Result<String, Error> {
    let info = table_info(client, schema, name).await?;
    let qualified = quote_qualified(schema, name);
    let mut out = String::new();
    match info.kind {
        RelationKind::View | RelationKind::MaterializedView => {
            let row = client
                .query_one(
                    "SELECT pg_get_viewdef(c.oid, true) FROM pg_class c \
                     JOIN pg_namespace n ON n.oid = c.relnamespace \
                     WHERE n.nspname = $1 AND c.relname = $2",
                    &[&schema, &name],
                )
                .await?;
            let body: String = row.try_get(0)?;
            let keyword = if info.kind == RelationKind::View {
                "VIEW"
            } else {
                "MATERIALIZED VIEW"
            };
            out.push_str(&format!(
                "CREATE {keyword} {qualified} AS\n{};\n",
                body.trim_end().trim_end_matches(';')
            ));
            for index in &info.indexes {
                out.push_str(&format!("{};\n", index.definition));
            }
        }
        _ => {
            let mut lines: Vec<String> = info
                .columns
                .iter()
                .map(|c| {
                    let mut line = format!("  {} {}", quote_ident(&c.name), c.type_name);
                    if c.not_null {
                        line.push_str(" NOT NULL");
                    }
                    if let Some(default) = &c.default {
                        line.push_str(&format!(" DEFAULT {default}"));
                    }
                    line
                })
                .collect();
            for constraint in &info.constraints {
                lines.push(format!(
                    "  CONSTRAINT {} {}",
                    quote_ident(&constraint.name),
                    constraint.definition
                ));
            }
            out.push_str(&format!(
                "CREATE TABLE {qualified} (\n{}\n);\n",
                lines.join(",\n")
            ));
            let constraint_names: Vec<&str> =
                info.constraints.iter().map(|c| c.name.as_str()).collect();
            for index in info
                .indexes
                .iter()
                .filter(|i| !constraint_names.contains(&i.name.as_str()))
            {
                out.push_str(&format!("{};\n", index.definition));
            }
        }
    }
    if let Some(comment) = &info.comment {
        let object = match info.kind {
            RelationKind::View => "VIEW",
            RelationKind::MaterializedView => "MATERIALIZED VIEW",
            RelationKind::ForeignTable => "FOREIGN TABLE",
            RelationKind::Table | RelationKind::PartitionedTable => "TABLE",
        };
        out.push_str(&format!(
            "COMMENT ON {object} {qualified} IS {};\n",
            db_editor_core::sql::quote_literal(comment)
        ));
    }
    for column in &info.columns {
        if let Some(comment) = &column.comment {
            out.push_str(&format!(
                "COMMENT ON COLUMN {qualified}.{} IS {};\n",
                quote_ident(&column.name),
                db_editor_core::sql::quote_literal(comment)
            ));
        }
    }
    Ok(out)
}
