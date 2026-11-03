use db_editor_core::copy::{CopyColumn, CopyError, CopyFormat, CopyRequest, CopyTable, render};

fn column(name: &str, type_name: &str) -> CopyColumn {
    CopyColumn {
        name: name.to_owned(),
        type_name: type_name.to_owned(),
    }
}

fn request(format: CopyFormat) -> CopyRequest {
    CopyRequest {
        format,
        columns: vec![
            column("id", "bigint"),
            column("name", "text"),
            column("active", "boolean"),
            column("profile", "jsonb"),
        ],
        rows: vec![
            vec![
                Some("1".into()),
                Some("O'Brien, \"Pat\"".into()),
                Some("t".into()),
                Some("{\"lang\": \"ja\"}".into()),
            ],
            vec![
                Some("2".into()),
                Some("line1\nline2|x".into()),
                Some("f".into()),
                None,
            ],
        ],
        table: Some(CopyTable {
            schema: "public".into(),
            name: "users".into(),
            key_columns: vec![column("id", "bigint")],
        }),
        key_values: vec![vec![Some("1".into())], vec![Some("2".into())]],
    }
}

#[test]
fn every_format_snapshot() {
    let formats = [
        CopyFormat::Tsv,
        CopyFormat::TsvWithHeader,
        CopyFormat::Csv,
        CopyFormat::Json,
        CopyFormat::Markdown,
        CopyFormat::Insert,
        CopyFormat::Update,
        CopyFormat::Where,
    ];
    let out = formats
        .iter()
        .map(|f| format!("== {f:?}\n{}", render(&request(*f)).unwrap()))
        .collect::<Vec<_>>()
        .join("\n");
    insta::assert_snapshot!(out);
}

#[test]
fn keyed_formats_need_a_table_key() {
    let mut req = request(CopyFormat::Update);
    req.table = None;
    assert_eq!(render(&req), Err(CopyError::NoKey));
    req.format = CopyFormat::Where;
    assert_eq!(render(&req), Err(CopyError::NoKey));
}

#[test]
fn composite_keys_use_row_values() {
    let mut req = request(CopyFormat::Where);
    if let Some(t) = req.table.as_mut() {
        t.key_columns = vec![column("tenant", "text"), column("id", "bigint")];
    }
    req.key_values = vec![
        vec![Some("a".into()), Some("1".into())],
        vec![Some("b".into()), Some("2".into())],
    ];
    assert_eq!(
        render(&req).unwrap(),
        "(\"tenant\", \"id\") IN (('a', 1), ('b', 2))"
    );
}
