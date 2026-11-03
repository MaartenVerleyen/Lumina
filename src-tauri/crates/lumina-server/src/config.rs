// lumina-server.toml:
//
//   data_dir = "/data"                     # database, thumbnails, frames, face crops, models
//   libraries = ["/photos"]                # folders the server keeps scanned
//   ollama_url = "http://ollama:11434"     # optional; captions need it
//   caption_model = "qwen3-vl:8b-instruct" # optional; set it to caption new photos automatically
//   listen = "127.0.0.1:8080"              # the web server (HTTPS comes from `tailscale serve` in front)
//   web_dir = "/opt/lumina/web"            # the built web client (default: `dist` next to the binary,
//                                          # else /opt/lumina/web)
//   upload_library = "/photos"             # where uploads go, in uploads/<user>/ (default: the first library)
//
// Environment variables override the file (handy in Docker): LUMINA_DATA_DIR, LUMINA_LIBRARIES (folders
// separated by ";"), LUMINA_OLLAMA_URL, LUMINA_CAPTION_MODEL, LUMINA_LISTEN, LUMINA_WEB_DIR and
// LUMINA_UPLOAD_LIBRARY.
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
    pub listen: Option<String>,
    pub web_dir: Option<PathBuf>,
    pub upload_library: Option<String>,
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
        if let Some(listen) = var("LUMINA_LISTEN") {
            self.listen = Some(listen);
        }
        if let Some(dir) = var("LUMINA_WEB_DIR") {
            self.web_dir = Some(PathBuf::from(dir));
        }
        if let Some(root) = var("LUMINA_UPLOAD_LIBRARY") {
            self.upload_library = Some(root);
        }
        self
    }

    pub fn data_dir(&self) -> PathBuf {
        self.data_dir.clone().unwrap_or_else(|| PathBuf::from("lumina-data"))
    }

    pub fn listen(&self) -> String {
        self.listen.clone().unwrap_or_else(|| "127.0.0.1:8080".to_string())
    }

    // The configured folder, or `dist` next to the binary, or /opt/lumina/web (the Docker image)
    pub fn web_dir(&self) -> Option<PathBuf> {
        if let Some(dir) = &self.web_dir {
            return Some(dir.clone());
        }
        let beside_binary = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("dist")));
        [beside_binary, Some(PathBuf::from("/opt/lumina/web"))]
            .into_iter()
            .flatten()
            .find(|d| d.join("index.html").is_file())
    }
}
