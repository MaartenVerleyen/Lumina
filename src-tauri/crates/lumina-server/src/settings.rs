// What the admin page changes about the server while it runs: libraries added and taken off, where uploads
// go, the caption model and Ollama's address. Saved as server-settings.json in the data folder, on top of
// lumina-server.toml; what an environment variable sets (Docker) wins over both, and the admin page shows
// it as fixed.
//
// A library taken off isn't scanned, watched or shown any more, but its row and its photos' values (ratings,
// faces, albums) stay in the database: adding the folder again brings them back.
use crate::config::Config;
use lumina_core::libraries::{self, Library};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const FILE: &str = "server-settings.json";

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Saved {
    // None: the configuration file's list
    pub libraries: Option<Vec<String>>,
    pub removed_libraries: Vec<String>,
    pub upload_library: Option<String>,
    // Some(""): no captions
    pub caption_model: Option<String>,
    pub ollama_url: Option<String>,
}

// The settings in force
#[derive(Clone, Debug, Default, Serialize)]
pub struct Live {
    pub libraries: Vec<String>,
    pub removed_libraries: Vec<String>,
    pub upload_library: Option<String>,
    pub caption_model: Option<String>,
    pub ollama_url: Option<String>,
    // Set by an environment variable: the admin page can't change these
    pub fixed: Vec<String>,
    #[serde(skip)]
    file: Option<PathBuf>,
}

static LIVE: Mutex<Option<Live>> = Mutex::new(None);

pub fn load_saved(data_dir: &Path) -> Saved {
    let path = data_dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            eprintln!("[settings] {} can't be read ({e}); using lumina-server.toml alone", path.display());
            Saved::default()
        }),
        Err(_) => Saved::default(),
    }
}

// The configuration with what the admin page saved on top (variables still win), and those settings in force
pub fn apply(config: &mut Config) {
    let data_dir = config.data_dir();
    let saved = load_saved(&data_dir);
    let fixed = |name: &str| config.from_env.iter().any(|f| f == name);
    if let Some(list) = saved.libraries.clone().filter(|_| !fixed("libraries")) {
        config.libraries = list;
    }
    if saved.upload_library.is_some() && !fixed("upload_library") {
        config.upload_library = saved.upload_library.clone().filter(|r| !r.is_empty());
    }
    if saved.caption_model.is_some() && !fixed("caption_model") {
        config.caption_model = saved.caption_model.clone().filter(|m| !m.is_empty());
    }
    if saved.ollama_url.is_some() && !fixed("ollama_url") {
        config.ollama_url = saved.ollama_url.clone().filter(|u| !u.is_empty());
    }
    // A library listed (again) in the file or a variable is served, whatever was taken off before
    let removed = saved.removed_libraries.into_iter().filter(|r| !config.libraries.iter().any(|l| same_root(l, r))).collect();
    *LIVE.lock().unwrap() = Some(Live {
        libraries: config.libraries.iter().map(|r| libraries::normalize_root(r)).collect(),
        removed_libraries: removed,
        upload_library: config.upload_library.clone(),
        caption_model: config.caption_model.clone(),
        ollama_url: config.ollama_url.clone(),
        fixed: config.from_env.clone(),
        file: Some(data_dir.join(FILE)),
    });
}

pub fn live() -> Live {
    LIVE.lock().unwrap().clone().unwrap_or_default()
}

// Changes the settings in force and saves them (only what isn't fixed by a variable is written)
pub fn update(change: impl FnOnce(&mut Live) -> Result<(), String>) -> Result<Live, String> {
    let mut slot = LIVE.lock().unwrap();
    let live = slot.as_mut().ok_or("The server's settings aren't loaded")?;
    let mut next = live.clone();
    change(&mut next)?;
    if let Some(file) = &next.file {
        let not_fixed = |name: &str| !next.fixed.iter().any(|f| f == name);
        let saved = Saved {
            libraries: not_fixed("libraries").then(|| next.libraries.clone()),
            removed_libraries: next.removed_libraries.clone(),
            upload_library: not_fixed("upload_library").then(|| next.upload_library.clone().unwrap_or_default()),
            caption_model: not_fixed("caption_model").then(|| next.caption_model.clone().unwrap_or_default()),
            ollama_url: not_fixed("ollama_url").then(|| next.ollama_url.clone().unwrap_or_default()),
        };
        let text = serde_json::to_string_pretty(&saved).map_err(|e| e.to_string())?;
        // Written next to it first, so a crash can't leave half a file
        let part = file.with_extension("json.part");
        std::fs::write(&part, text).and_then(|_| std::fs::rename(&part, file)).map_err(|e| format!("Can't save {}: {e}", file.display()))?;
    }
    *live = next.clone();
    Ok(next)
}

pub fn same_root(a: &str, b: &str) -> bool {
    let (a, b) = (libraries::normalize_root(a), libraries::normalize_root(b));
    if cfg!(windows) { a.eq_ignore_ascii_case(&b) } else { a == b }
}

pub fn is_removed(root: &str) -> bool {
    LIVE.lock().unwrap().as_ref().is_some_and(|l| l.removed_libraries.iter().any(|r| same_root(r, root)))
}

// The libraries the server shows: those in the database, less the ones taken off
pub fn served(all: Vec<Library>) -> Vec<Library> {
    all.into_iter().filter(|l| !is_removed(&l.root)).collect()
}
