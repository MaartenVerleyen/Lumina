// The phone app's updates (docs/plans/android.md, milestone 6). There is no app store: each GitHub release has the
// APK (Lumina_<version>_android_arm64.apk, built by .github/workflows/desktop.yml). The app asks GitHub once a day
// whether a newer release has one; on Update it downloads the APK into its cache and hands it to Android's
// installer, which asks first (and the first time, whether Lumina may install apps at all).
use crate::*;
use serde::Serialize;
use std::sync::{LazyLock, Mutex};

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const LATEST_RELEASE: &str = "https://api.github.com/repos/MaartenVerleyen/Lumina/releases/latest";

#[derive(Serialize, Clone)]
pub struct Update {
    version: String,
    url: String,
    size: u64,
    // The release's notes, as written on GitHub
    notes: String,
}

#[derive(Serialize, Clone, Default)]
pub struct UpdateProgress {
    running: bool,
    done: u64,
    total: u64,
    error: Option<String>,
}

static PROGRESS: LazyLock<Mutex<UpdateProgress>> = LazyLock::new(|| Mutex::new(UpdateProgress::default()));

// "5.1.0" is newer than "5.0.2"; a tag may start with "v"
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn newer(candidate: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.trim_start_matches('v').split(['.', '-']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    parts(candidate) > parts(current)
}

// A newer release with an APK for this phone, or nothing
#[tauri::command]
pub async fn phone_update_check(app: AppHandle) -> Result<Option<Update>, String> {
    #[cfg(target_os = "android")]
    {
        let http = reqwest::Client::builder()
            .user_agent(format!("Lumina-Android/{}", app.package_info().version))
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| e.to_string())?;
        let release: serde_json::Value = http
            .get(LATEST_RELEASE)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| format!("Can't reach GitHub to look for updates ({e})"))?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let version = release["tag_name"].as_str().unwrap_or("").trim_start_matches('v').to_string();
        if version.is_empty() || !newer(&version, &app.package_info().version.to_string()) {
            return Ok(None);
        }
        let apk = release["assets"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|a| a["name"].as_str().is_some_and(|n| n.ends_with("_android_arm64.apk")));
        Ok(apk.map(|a| Update {
            version,
            url: a["browser_download_url"].as_str().unwrap_or("").to_string(),
            size: a["size"].as_u64().unwrap_or(0),
            notes: release["body"].as_str().unwrap_or("").to_string(),
        }))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

// The APK downloaded, then Android's installer; how far the download is: phone_update_progress
#[tauri::command]
pub async fn phone_update_install(app: AppHandle, url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        use futures_util::StreamExt;
        use std::io::Write;
        use tauri::Manager;
        if !url.starts_with("https://github.com/MaartenVerleyen/Lumina/releases/download/") {
            return Err("Not a Lumina release".into());
        }
        *PROGRESS.lock().unwrap() = UpdateProgress { running: true, ..Default::default() };
        let outcome: Result<std::path::PathBuf, String> = async {
            let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("update");
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let file_path = dir.join("Lumina.apk");
            let resp = reqwest::Client::new().get(&url).send().await.map_err(|e| format!("Can't download the update ({e})"))?;
            if !resp.status().is_success() {
                return Err(format!("Can't download the update (GitHub answered {})", resp.status()));
            }
            PROGRESS.lock().unwrap().total = resp.content_length().unwrap_or(0);
            let mut file = fs::File::create(&file_path).map_err(|e| e.to_string())?;
            let mut stream = resp.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("The download broke off ({e})"))?;
                file.write_all(&chunk).map_err(|e| e.to_string())?;
                PROGRESS.lock().unwrap().done += chunk.len() as u64;
            }
            Ok(file_path)
        }
        .await;
        {
            let mut p = PROGRESS.lock().unwrap();
            p.running = false;
            if let Err(e) = &outcome {
                p.error = Some(e.clone());
            }
        }
        match outcome {
            Ok(path) => {
                let app2 = app.clone();
                // Off the main thread: the plugin's commands run there
                tauri::async_runtime::spawn_blocking(move || {
                    crate::android::call(&app2, "installApk", serde_json::json!({ "path": path.to_string_lossy() })).map(|_| ())
                })
                .await
                .map_err(|e| e.to_string())?
            }
            Err(e) => Err(e),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, url);
        Err("Updating this way is the phone app's".into())
    }
}

#[tauri::command]
pub fn phone_update_progress() -> UpdateProgress {
    PROGRESS.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::newer;

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("5.1.0", "5.0.9"));
        assert!(newer("v5.0.10", "5.0.9"));
        assert!(!newer("5.0.0", "5.0.0"));
        assert!(!newer("4.9.9", "5.0.0"));
    }
}
