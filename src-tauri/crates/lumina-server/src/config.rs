// lumina-server.toml:
//
//   data_dir = "/data"                     # database, thumbnails, frames, face crops, models
//   libraries = ["/photos"]                # folders the server keeps scanned
//   ollama_url = "http://ollama:11434"     # optional; captions need it
//   caption_model = "qwen3-vl:8b-instruct" # optional; set it to caption new photos automatically
//
// Environment variables override the file (handy in Docker): LUMINA_DATA_DIR, LUMINA_LIBRARIES (folders
// separated by ";"), LUMINA_OLLAMA_URL and LUMINA_CAPTION_MODEL.
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Default, Debug)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub data_dir: Option<PathBuf>,
    #[serde(default)]
    pub libraries: Vec<String>,
    pub ollama_url: Option<String>,
    pub caption_model: Option<String>,
}

impl Config {
    // The file at `path`, or ./lumina-server.toml when it exists, or nothing
    pub fn load(path: Option<&Path>) -> Result<Config, String> {
        let default = Path::new("lumina-server.toml");
        let path = match path {
            Some(p) => p,
            None if default.exists() => default,
            None => return Ok(Config::default().with_env()),
        };
        let text = std::fs::read_to_string(path).map_err(|e| format!("Can't read {}: {e}", path.display()))?;
        let config: Config = toml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(config.with_env())
    }

    fn with_env(mut self) -> Config {
        if let Some(dir) = std::env::var_os("LUMINA_DATA_DIR").filter(|d| !d.is_empty()) {
            self.data_dir = Some(PathBuf::from(dir));
        }
        let var = |name: &str| std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        if let Some(list) = var("LUMINA_LIBRARIES") {
            self.libraries = list.split(';').map(|r| r.trim().to_string()).filter(|r| !r.is_empty()).collect();
        }
        if let Some(url) = var("LUMINA_OLLAMA_URL") {
            self.ollama_url = Some(url);
        }
        if let Some(model) = var("LUMINA_CAPTION_MODEL") {
            self.caption_model = Some(model);
        }
        self
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone().unwrap_or_else(|| PathBuf::from("lumina-data"))
    }
}
