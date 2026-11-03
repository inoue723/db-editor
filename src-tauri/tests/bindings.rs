//! Regenerates `src/bindings.ts`. CI runs this and fails if the file changed,
//! so the committed bindings always match the Rust commands.

#[test]
fn export_typescript_bindings() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts");
    db_editor_lib::export_bindings(path).unwrap();
}
