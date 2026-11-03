//! Domain logic that does not depend on Tauri or a live database.
//!
//! Keeping this crate free of Tauri lets it be tested quickly without a WebView.

pub mod copy;
pub mod filter;
pub mod sql;
pub mod tsv;
pub mod url;
