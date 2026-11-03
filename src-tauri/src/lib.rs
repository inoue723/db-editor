//! Tauri application: command definitions and app setup.

mod commands;

use tauri_specta::{Builder, collect_commands};

/// Path of the generated TypeScript bindings, relative to `src-tauri/`.
pub const BINDINGS_PATH: &str = "../src/bindings.ts";

/// Builds the command registry shared by the app and the bindings exporter.
#[must_use]
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![commands::parse_tsv])
}

/// Writes the TypeScript bindings for all commands.
///
/// # Errors
///
/// Returns an error when the bindings cannot be generated or written.
pub fn export_bindings(path: &str) -> Result<(), Box<dyn std::error::Error>> {
    specta_builder().export(
        specta_typescript::Typescript::default().header("// @ts-nocheck"),
        path,
    )?;
    Ok(())
}

/// Starts the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let builder = specta_builder();

    #[cfg(debug_assertions)]
    if let Err(error) = export_bindings(BINDINGS_PATH) {
        tracing::error!(%error, "failed to export TypeScript bindings");
    }

    let result = tauri::Builder::default()
        // Restarts the app after an update has been installed.
        .plugin(tauri_plugin_process::init())
        // Checks GitHub Releases for a signed update (see `plugins.updater` in tauri.conf.json).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        tracing::error!(%error, "error while running the application");
        std::process::exit(1);
    }
}
