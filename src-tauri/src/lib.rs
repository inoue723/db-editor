//! Tauri application: command definitions and app setup.

mod commands;
mod state;
mod store;

use tauri::Manager;
use tauri_specta::{Builder, collect_commands};

use crate::state::AppState;
use crate::store::{History, Keybindings, KeyringSecrets, Profiles, SavedQueries};

/// Path of the generated TypeScript bindings, relative to `src-tauri/`.
pub const BINDINGS_PATH: &str = "../src/bindings.ts";

/// Builds the command registry shared by the app and the bindings exporter.
#[must_use]
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::parse_tsv,
        commands::list_connections,
        commands::save_connection,
        commands::delete_connection,
        commands::has_saved_password,
        commands::parse_connection_url,
        commands::test_connection,
        commands::open_connection_window,
        commands::session_connect,
        commands::list_databases,
        commands::load_schemas,
        commands::table_info,
        commands::table_ddl,
        commands::fetch_page,
        commands::count_references,
        commands::run_sql,
        commands::cancel_query,
        commands::query_history,
        commands::list_saved_queries,
        commands::save_query,
        commands::delete_saved_query,
        commands::preview_changes,
        commands::save_changes,
        commands::copy_selection,
        commands::write_clipboard,
        commands::read_clipboard,
        commands::load_keybindings,
        commands::save_keybindings,
    ])
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_data_dir()?;
            app.manage(AppState::new(
                Profiles::new(&config_dir),
                History::new(&data_dir),
                SavedQueries::new(&config_dir),
                Keybindings::new(&config_dir),
                Box::new(KeyringSecrets),
            ));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                commands::forget_window(window.app_handle(), window.label());
            }
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        tracing::error!(%error, "error while running the application");
        std::process::exit(1);
    }
}
