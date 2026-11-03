use db_editor_core::tsv;
use proptest::prelude::*;

#[test]
fn encode_snapshot() {
    let rows = [
        vec!["id", "name", "note"],
        vec!["1", "Alice", "line1\nline2"],
        vec!["2", "Bob \"B\"", "tab\there"],
        vec!["3", "", "日本語"],
    ];
    insta::assert_snapshot!(tsv::encode(rows));
}

fn rows_strategy() -> impl Strategy<Value = Vec<Vec<String>>> {
    // At least one row and one column; every row has the same width, like a grid selection.
    (1usize..5, 1usize..6).prop_flat_map(|(cols, rows)| {
        prop::collection::vec(prop::collection::vec(any::<String>(), cols), rows)
    })
}

proptest! {
    /// Copy then paste must give back exactly what was copied.
    #[test]
    fn encode_then_parse_round_trips(rows in rows_strategy()) {
        let text = tsv::encode(&rows);
        prop_assert_eq!(tsv::parse(&text).unwrap(), rows);
    }
}
