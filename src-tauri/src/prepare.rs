// ----------------- `--prepare-models`: MODEL DOWNLOADS FOR LUMINA SETUP -----------------
// `Lumina.exe --prepare-models faces,clip` downloads the face and smart-search models without opening a
// window, using exactly the app's download and checksum code, and reports progress on stdout as one JSON
// object per line for Lumina Setup to show:
//   {"step":"faces","downloaded":1048576,"total":288621354}
//   {"step":"faces","status":"done"}            ("ready" when the models were already there)
//   {"step":"clip","status":"error","message":"..."}
// Exit code 0 when every requested step succeeded, 1 otherwise.

use crate::*;
use std::io::Write as _;
use std::sync::atomic::AtomicU64;

pub use lumina_core::host::APP_IDENTIFIER;

pub fn models_dir() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is not set")?;
    let dir = PathBuf::from(base).join(APP_IDENTIFIER).join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn emit(line: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

// Progress lines at most every 1 MB, so the pipe isn't flooded
fn reporter(step: &'static str) -> impl Fn(u64, u64) + Send + Sync {
    let last_mb = AtomicU64::new(u64::MAX);
    move |done: u64, total: u64| {
        let mb = done / 1_048_576;
        if last_mb.swap(mb, Ordering::Relaxed) != mb || done == total {
            emit(serde_json::json!({ "step": step, "downloaded": done, "total": total }));
        }
    }
}

// `steps`: comma-separated "faces" and/or "clip"
pub fn run(steps: &str) -> i32 {
    let dir = match models_dir() {
        Ok(d) => d,
        Err(e) => {
            emit(serde_json::json!({ "step": "setup", "status": "error", "message": e }));
            return 1;
        }
    };
    let mut ok = true;
    for step in steps.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        let result: Result<bool, String> = match step {
            "faces" => {
                let progress = reporter("faces");
                tauri::async_runtime::block_on(face_ort::ensure_face_models_in(&dir, &progress))
            }
            "clip" => {
                let progress = reporter("clip");
                let present = clip::clip_models_present(&dir);
                tauri::async_runtime::block_on(clip::ensure_clip_models_in(&dir, &progress, &|| false)).map(|_| !present)
            }
            other => Err(format!("Unknown step \"{other}\"")),
        };
        match result {
            Ok(downloaded) => emit(serde_json::json!({ "step": step, "status": if downloaded { "done" } else { "ready" } })),
            Err(message) => {
                ok = false;
                emit(serde_json::json!({ "step": step, "status": "error", "message": message }));
            }
        }
    }
    if ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    #[test]
    fn prepare_models_uses_the_configured_app_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"].as_str(), Some(super::APP_IDENTIFIER));
    }
}
