//! Per-window connection state.
//!
//! The launcher lives in the `main` window. Each opened connection gets its own
//! window (`conn-N`) with two server sessions: one for browsing (catalog and table
//! pages) and one for the SQL editor, so that a transaction left open in the editor
//! never blocks or hides browsing.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use db_editor_pg::{ConnectOptions, Session};

use crate::store::{ConnectionProfile, History, Keybindings, Profiles, SavedQueries, Secrets};

/// An open connection of a window.
pub struct Connected {
    pub profile: ConnectionProfile,
    pub database: String,
    pub server_version: String,
    pub options: ConnectOptions,
    pub browse: Session,
    pub editor: Session,
    /// Saves row changes in its own transactions, so that browsing queries running at
    /// the same time never end up inside them. Opened on the first save; the lock
    /// also keeps two saves of one window from interleaving.
    pub writer: tokio::sync::Mutex<Option<Session>>,
}

/// The last grid selection copied as TSV, with NULLs that plain text cannot carry.
pub struct CopiedCells {
    pub text: String,
    pub cells: Vec<Vec<Option<String>>>,
}

struct WindowEntry {
    profile_id: String,
    connected: Option<Arc<Connected>>,
}

/// Shared application state.
pub struct AppState {
    pub profiles: Profiles,
    pub history: History,
    pub saved_queries: SavedQueries,
    pub keybindings: Keybindings,
    pub secrets: Box<dyn Secrets>,
    pub last_copy: Mutex<Option<CopiedCells>>,
    windows: Mutex<HashMap<String, WindowEntry>>,
    next_window: AtomicU64,
}

impl AppState {
    #[must_use]
    pub fn new(
        profiles: Profiles,
        history: History,
        saved_queries: SavedQueries,
        keybindings: Keybindings,
        secrets: Box<dyn Secrets>,
    ) -> Self {
        Self {
            profiles,
            history,
            saved_queries,
            keybindings,
            secrets,
            last_copy: Mutex::new(None),
            windows: Mutex::new(HashMap::new()),
            next_window: AtomicU64::new(1),
        }
    }

    fn windows(&self) -> std::sync::MutexGuard<'_, HashMap<String, WindowEntry>> {
        // A panic while holding the lock cannot leave the map half-updated.
        self.windows.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reserves a window label for a connection profile.
    pub fn register_window(&self, profile_id: &str) -> String {
        let label = format!("conn-{}", self.next_window.fetch_add(1, Ordering::Relaxed));
        self.windows().insert(
            label.clone(),
            WindowEntry {
                profile_id: profile_id.to_owned(),
                connected: None,
            },
        );
        label
    }

    /// The profile a connection window was opened for.
    #[must_use]
    pub fn window_profile(&self, label: &str) -> Option<String> {
        self.windows().get(label).map(|w| w.profile_id.clone())
    }

    /// The window's open connection.
    #[must_use]
    pub fn connected(&self, label: &str) -> Option<Arc<Connected>> {
        self.windows().get(label).and_then(|w| w.connected.clone())
    }

    /// Replaces the window's connection (the previous one closes when dropped).
    pub fn set_connected(&self, label: &str, connected: Option<Arc<Connected>>) {
        if let Some(entry) = self.windows().get_mut(label) {
            entry.connected = connected;
        }
    }

    /// Forgets a closed window, closing its connection.
    pub fn remove_window(&self, label: &str) {
        self.windows().remove(label);
    }
}
