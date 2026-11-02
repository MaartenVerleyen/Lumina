// Lumina Setup: a guided installer around Lumina's own NSIS installer.
//
// Steps, in order (each reports progress as `setup-progress` events):
//   remove-old  uninstall a per-machine install from an older version (asks for administrator rights)
//   lumina      run the embedded NSIS installer silently into the chosen folder
//   faces       face recognition models   } downloaded by the installed app itself
//   clip        smart search models       } (`Lumina.exe --prepare-models`), with its checksums
//   ollama      download and silently install Ollama, if it isn't installed yet
//   model       pull the vision model through Ollama's API
// A failed step doesn't stop the others (except Lumina itself), and can be retried.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const PRODUCT: &str = "Lumina";
// Lumina's app identifier: its data lives in %LOCALAPPDATA%\<identifier>
const APP_ID: &str = "com.amazhr.lumina";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumina";
const OLLAMA_SETUP_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
const OLLAMA_API: &str = "http://127.0.0.1:11434";
pub const AI_MODEL: &str = "qwen3-vl:8b-instruct";

// Download sizes shown before installing (measured 2026-10-27; the real sizes come from the servers)
const OLLAMA_BYTES: u64 = 1_662_012_016;
const MODEL_BYTES: u64 = 6_190_000_000;
const FACES_BYTES: u64 = 288_621_354;
const CLIP_BYTES: u64 = 490_598_319;
// Model files the app needs, with their sizes (a quick "already there?" check; the app verifies checksums)
const FACE_FILES: [(&str, u64); 2] = [("det_10g.onnx", 16_923_827), ("w600k_r50.onnx", 174_383_860)];
const CLIP_FILES: [(&str, u64); 4] = [
    ("clip_vision.onnx", 351_685_709),
    ("clip_text_quint8.onnx", 135_377_779),
    ("clip_text_dense.safetensors", 1_572_984),
    ("clip_text_tokenizer.json", 1_961_847),
];

static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.exe"));
static CANCEL: AtomicBool = AtomicBool::new(false);

// ----------------- What is on this PC -----------------

#[derive(Serialize, Clone)]
pub struct ExistingInstall {
    pub dir: String,
    pub version: String,
    pub uninstaller: String,
}

#[derive(Serialize)]
pub struct Sizes {
    pub ollama: u64,
    pub model: u64,
    pub faces: u64,
    pub clip: u64,
}

#[derive(Serialize)]
pub struct SystemInfo {
    pub version: String,
    pub can_install: bool,
    pub default_dir: String,
    pub user_install: Option<ExistingInstall>,
    pub machine_install: Option<ExistingInstall>,
    pub lumina_running: bool,
    pub ollama_installed: bool,
    pub model_present: bool,
    pub faces_present: bool,
    pub clip_present: bool,
    pub ai_model: String,
    pub sizes: Sizes,
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn local_appdata() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default()
}

fn models_dir() -> PathBuf {
    local_appdata().join(APP_ID).join("models")
}

fn files_present(dir: &Path, files: &[(&str, u64)]) -> bool {
    files.iter().all(|(name, size)| dir.join(name).metadata().map(|m| m.len() == *size).unwrap_or(false))
}

// "Lumina_3.6.0_x64-setup.exe" -> "3.6.0"
fn payload_version() -> String {
    option_env!("LUMINA_PAYLOAD_NAME")
        .and_then(|n| n.split('_').nth(1))
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .to_string()
}

// One value from the registry through `reg query` (HKCU or HKLM, 64-bit view)
fn reg_value(root: &str, key: &str, name: &str) -> Option<String> {
    let out = hidden(Command::new("reg").args(["query", &format!(r"{root}\{key}"), "/v", name, "/reg:64"])).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| l.trim_start().starts_with(name))?;
    let value = line.splitn(2, "REG_").nth(1)?.split_once(char::is_whitespace)?.1.trim();
    Some(value.trim_matches('"').to_string())
}

fn existing_install(root: &str) -> Option<ExistingInstall> {
    let dir = reg_value(root, UNINSTALL_KEY, "InstallLocation")?;
    Some(ExistingInstall {
        version: reg_value(root, UNINSTALL_KEY, "DisplayVersion").unwrap_or_default(),
        uninstaller: reg_value(root, UNINSTALL_KEY, "UninstallString").unwrap_or_default(),
        dir,
    })
}

fn lumina_running() -> bool {
    hidden(Command::new("tasklist").args(["/FI", "IMAGENAME eq Lumina.exe", "/NH"]))
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("lumina.exe"))
        .unwrap_or(false)
}

fn ollama_exe() -> Option<PathBuf> {
    let default = local_appdata().join(r"Programs\Ollama\ollama.exe");
    if default.exists() {
        return Some(default);
    }
    let out = hidden(Command::new("where").arg("ollama")).output().ok()?;
    let first = String::from_utf8_lossy(&out.stdout).lines().next()?.trim().to_string();
    (!first.is_empty()).then(|| PathBuf::from(first))
}

// Whether Ollama already has the model, from its manifest on disk (works while Ollama isn't running)
fn model_present() -> bool {
    let models = std::env::var_os("OLLAMA_MODELS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(r".ollama\models"));
    let (name, tag) = AI_MODEL.split_once(':').unwrap_or((AI_MODEL, "latest"));
    models.join(r"manifests\registry.ollama.ai\library").join(name).join(tag).exists()
}

#[tauri::command]
fn system_info() -> SystemInfo {
    let user_install = existing_install("HKCU");
    SystemInfo {
        version: payload_version(),
        can_install: !PAYLOAD.is_empty(),
        default_dir: user_install
            .as_ref()
            .map(|i| i.dir.clone())
            .unwrap_or_else(|| local_appdata().join("Programs").join(PRODUCT).to_string_lossy().to_string()),
        user_install,
        machine_install: existing_install("HKLM"),
        lumina_running: lumina_running(),
        ollama_installed: ollama_exe().is_some(),
        model_present: model_present(),
        faces_present: files_present(&models_dir(), &FACE_FILES),
        clip_present: files_present(&models_dir(), &CLIP_FILES),
        ai_model: AI_MODEL.to_string(),
        sizes: Sizes { ollama: OLLAMA_BYTES, model: MODEL_BYTES, faces: FACES_BYTES, clip: CLIP_BYTES },
    }
}

// Free bytes on the drive that holds `path` (or the nearest folder of it that exists)
#[tauri::command]
fn free_space(path: String) -> Option<u64> {
    let mut p = PathBuf::from(path);
    while !p.exists() {
        p = p.parent()?.to_path_buf();
    }
    #[cfg(windows)]
    {
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        use windows::core::HSTRING;
        let mut free = 0u64;
        unsafe { GetDiskFreeSpaceExW(&HSTRING::from(p.as_os_str()), Some(&mut free), None, None).ok()? };
        Some(free)
    }
    #[cfg(not(windows))]
    None
}

#[tauri::command]
async fn pick_folder(app: AppHandle, current: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let start = PathBuf::from(&current);
    let start = start.parent().filter(|p| p.exists()).unwrap_or(&start).to_path_buf();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().set_title("Install Lumina in…").set_directory(start).blocking_pick_folder()
    })
    .await
    .ok()??;
    let dir = picked.into_path().ok()?;
    // Installing straight into a folder like "Downloads" would mix Lumina's files with others
    Some(if dir.file_name().is_some_and(|n| n.eq_ignore_ascii_case(PRODUCT)) { dir } else { dir.join(PRODUCT) }.to_string_lossy().to_string())
}

// ----------------- Installing -----------------

#[derive(Deserialize, Clone)]
pub struct InstallOptions {
    pub dir: String,
    pub desktop_shortcut: bool,
    pub ai: bool,
    pub flash_attention: bool,
    pub faces: bool,
    pub clip: bool,
    pub remove_machine_install: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct StepProgress {
    pub step: String,
    // waiting | active | done | error | skipped
    pub state: String,
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
}

static OPTIONS: Mutex<Option<InstallOptions>> = Mutex::new(None);

fn report(app: &AppHandle, step: &str, state: &str, message: impl Into<String>) {
    let _ = app.emit("setup-progress", StepProgress { step: step.into(), state: state.into(), message: message.into(), ..Default::default() });
}

fn report_bytes(app: &AppHandle, step: &str, downloaded: u64, total: u64, message: &str) {
    let _ = app.emit(
        "setup-progress",
        StepProgress { step: step.into(), state: "active".into(), downloaded, total, message: message.into() },
    );
}

fn cancelled() -> Result<(), String> {
    if CANCEL.load(Ordering::Acquire) { Err("Cancelled".into()) } else { Ok(()) }
}

// Downloads to `dest` (via dest.part), reporting progress about every MB
async fn download(app: &AppHandle, step: &str, url: &str, dest: &Path, expected: u64, message: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(url).send().await.map_err(|e| format!("Couldn't connect: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("The download failed (HTTP {})", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(expected);
    let part = dest.with_extension("part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let (mut done, mut last_mb) = (0u64, u64::MAX);
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("The download was interrupted: {e}"))? {
        if CANCEL.load(Ordering::Acquire) {
            drop(file);
            let _ = std::fs::remove_file(&part);
            return Err("Cancelled".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done / 1_048_576 != last_mb {
            last_mb = done / 1_048_576;
            report_bytes(app, step, done, total, message);
        }
    }
    drop(file);
    std::fs::rename(&part, dest).map_err(|e| e.to_string())
}

fn step_remove_old(app: &AppHandle) -> Result<(), String> {
    let Some(old) = existing_install("HKLM") else { return Ok(()) };
    report(app, "remove-old", "active", format!("Removing Lumina {} from {}", old.version, old.dir));
    let uninstaller = old.uninstaller.trim_matches('"').to_string();
    // The old version was installed for all users: Windows asks for administrator rights once
    let script = format!("Start-Process -FilePath '{}' -ArgumentList '/S' -Verb RunAs -Wait", uninstaller.replace('\'', "''"));
    let status = hidden(Command::new("powershell").args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]))
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() || existing_install("HKLM").is_some() {
        return Err("The old version wasn't removed (administrator rights were refused?). You can remove it later in Windows Settings > Apps.".into());
    }
    Ok(())
}

fn step_lumina(app: &AppHandle, opts: &InstallOptions) -> Result<(), String> {
    if PAYLOAD.is_empty() {
        return Err("This build of Setup doesn't contain Lumina. Build it with installer/build-setup.ps1.".into());
    }
    if lumina_running() {
        return Err("Lumina is open. Close it, then click Retry.".into());
    }
    report(app, "lumina", "active", "Copying files");
    let tmp = std::env::temp_dir().join(format!("lumina-setup-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let exe = tmp.join("Lumina-installer.exe");
    std::fs::write(&exe, PAYLOAD).map_err(|e| format!("Couldn't unpack Lumina: {e}"))?;

    let mut cmd = Command::new(&exe);
    cmd.arg("/S");
    if !opts.desktop_shortcut {
        cmd.arg("/NODESKTOP");
    }
    // NSIS wants /D last and unquoted, even with spaces in the path
    #[cfg(windows)]
    cmd.raw_arg(format!("/D={}", opts.dir));
    let status = hidden(&mut cmd).status().map_err(|e| format!("Couldn't start the Lumina installer: {e}"));
    let _ = std::fs::remove_dir_all(&tmp);
    match status?.code() {
        Some(0) => {}
        Some(2) => return Err("Lumina is open. Close it, then click Retry.".into()),
        code => return Err(format!("The Lumina installer stopped (code {}).", code.unwrap_or(-1))),
    }
    if !Path::new(&opts.dir).join("Lumina.exe").exists() {
        return Err("Lumina.exe wasn't installed.".into());
    }
    Ok(())
}

// Face or smart-search models, downloaded by the installed app (`--prepare-models`), which prints JSON lines
fn step_app_models(app: &AppHandle, opts: &InstallOptions, step: &str) -> Result<(), String> {
    let exe = Path::new(&opts.dir).join("Lumina.exe");
    if !exe.exists() {
        return Err("Lumina isn't installed yet.".into());
    }
    let message = if step == "faces" { "Downloading face recognition models" } else { "Downloading smart search models" };
    report(app, step, "active", message);
    let mut child = hidden(Command::new(&exe).args(["--prepare-models", step]))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start Lumina: {e}"))?;
    let mut error = None;
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if CANCEL.load(Ordering::Acquire) {
                let _ = child.kill();
                return Err("Cancelled".into());
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if let (Some(done), Some(total)) = (v["downloaded"].as_u64(), v["total"].as_u64()) {
                report_bytes(app, step, done, total, message);
            }
            if v["status"] == "error" {
                error = v["message"].as_str().map(str::to_string);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    match error {
        Some(e) => Err(e),
        None if !status.success() => Err("The download didn't finish.".into()),
        None => Ok(()),
    }
}

async fn ollama_running() -> bool {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(2)).build();
    match client {
        Ok(c) => c.get(format!("{OLLAMA_API}/api/version")).send().await.is_ok_and(|r| r.status().is_success()),
        Err(_) => false,
    }
}

// Starts Ollama's tray app (which runs the server) and waits up to 30 s for it to answer
async fn start_ollama(flash_attention: bool) -> Result<(), String> {
    if ollama_running().await {
        return Ok(());
    }
    let tray = local_appdata().join(r"Programs\Ollama\ollama app.exe");
    let mut cmd = if tray.exists() {
        Command::new(tray)
    } else {
        let mut c = Command::new(ollama_exe().ok_or("Ollama isn't installed.")?);
        c.arg("serve");
        c
    };
    if flash_attention {
        cmd.env("OLLAMA_FLASH_ATTENTION", "1");
    }
    hidden(&mut cmd).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| format!("Couldn't start Ollama: {e}"))?;
    for _ in 0..60 {
        if ollama_running().await {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Err("Ollama didn't start.".into())
}

async fn step_ollama(app: &AppHandle, opts: &InstallOptions) -> Result<(), String> {
    if opts.flash_attention {
        // About 10-15% faster captions with the same results; set before Ollama first starts
        let _ = hidden(Command::new("setx").args(["OLLAMA_FLASH_ATTENTION", "1"])).output();
    }
    if ollama_exe().is_none() {
        let tmp = std::env::temp_dir().join("OllamaSetup.exe");
        download(app, "ollama", OLLAMA_SETUP_URL, &tmp, OLLAMA_BYTES, "Downloading Ollama").await?;
        cancelled()?;
        report(app, "ollama", "active", "Installing Ollama");
        // Ollama's installer is an Inno Setup installer: these are its standard unattended flags
        let status = hidden(Command::new(&tmp).args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]))
            .status()
            .map_err(|e| format!("Couldn't start the Ollama installer: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        if !status.success() || ollama_exe().is_none() {
            return Err(format!("The Ollama installer stopped (code {}).", status.code().unwrap_or(-1)));
        }
    }
    report(app, "ollama", "active", "Starting Ollama");
    start_ollama(opts.flash_attention).await
}

// Pulls the model through Ollama's API. Each layer reports its own total; the sum is shown.
async fn step_model(app: &AppHandle, opts: &InstallOptions) -> Result<(), String> {
    if model_present() {
        return Ok(());
    }
    start_ollama(opts.flash_attention).await?;
    let message = format!("Downloading {AI_MODEL}");
    report(app, "model", "active", message.clone());
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .post(format!("{OLLAMA_API}/api/pull"))
        .json(&serde_json::json!({ "model": AI_MODEL, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Ollama: {e}"))?;
    let mut layers: HashMap<String, (u64, u64)> = HashMap::new();
    let mut buf = Vec::new();
    let mut last_mb = u64::MAX;
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("The download was interrupted: {e}"))? {
        // Leaving the loop drops the request; Ollama keeps what it has and resumes on Retry
        cancelled()?;
        buf.extend_from_slice(&chunk);
        while let Some(end) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=end).collect();
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&line) else { continue };
            if let Some(e) = v["error"].as_str() {
                return Err(format!("Ollama: {e}"));
            }
            if v["status"] == "success" {
                return Ok(());
            }
            if let (Some(digest), Some(total)) = (v["digest"].as_str(), v["total"].as_u64()) {
                layers.insert(digest.to_string(), (v["completed"].as_u64().unwrap_or(0), total));
                // Layers are announced one by one: until all are known, the expected size keeps the bar steady
                let done: u64 = layers.values().map(|l| l.0).sum();
                let total = layers.values().map(|l| l.1).sum::<u64>().max(MODEL_BYTES);
                if done / 1_048_576 != last_mb {
                    last_mb = done / 1_048_576;
                    report_bytes(app, "model", done, total, &message);
                }
            }
        }
    }
    if model_present() { Ok(()) } else { Err("The model download didn't finish.".into()) }
}

async fn run_step(app: &AppHandle, step: &str, opts: &InstallOptions) -> Result<(), String> {
    match step {
        "remove-old" => step_remove_old(app),
        "lumina" => step_lumina(app, opts),
        "faces" | "clip" => step_app_models(app, opts, step),
        "ollama" => step_ollama(app, opts).await,
        "model" => step_model(app, opts).await,
        other => Err(format!("Unknown step {other}")),
    }
}

// Runs the given steps in order. Without Lumina nothing else can follow; without Ollama there is no model.
async fn run_steps(app: AppHandle, steps: Vec<String>, opts: InstallOptions) {
    for (i, step) in steps.iter().enumerate() {
        if CANCEL.load(Ordering::Acquire) {
            for rest in &steps[i..] {
                report(&app, rest, "skipped", "Cancelled");
            }
            break;
        }
        report(&app, step, "active", "");
        match run_step(&app, step, &opts).await {
            Ok(()) => report(&app, step, "done", ""),
            Err(e) => {
                report(&app, step, "error", e);
                let blocked: &[&str] = match step.as_str() {
                    "lumina" => &["faces", "clip", "ollama", "model"],
                    "ollama" => &["model"],
                    _ => &[],
                };
                if !blocked.is_empty() {
                    for rest in steps[i + 1..].iter().filter(|s| blocked.contains(&s.as_str())) {
                        report(&app, rest, "skipped", "Waiting for an earlier step");
                    }
                    let remaining: Vec<String> = steps[i + 1..].iter().filter(|s| !blocked.contains(&s.as_str())).cloned().collect();
                    Box::pin(run_steps(app.clone(), remaining, opts.clone())).await;
                    break;
                }
            }
        }
    }
}

// Runs the steps in the background and tells the window when they're all over
fn spawn_steps(app: AppHandle, steps: Vec<String>, opts: InstallOptions) {
    tauri::async_runtime::spawn(async move {
        run_steps(app.clone(), steps, opts).await;
        let _ = app.emit("setup-finished", ());
    });
}

// The steps for these options, in order (shown up front so the window can list them)
fn plan(opts: &InstallOptions) -> Vec<String> {
    let mut steps = Vec::new();
    if opts.remove_machine_install && existing_install("HKLM").is_some() {
        steps.push("remove-old");
    }
    steps.push("lumina");
    if opts.faces {
        steps.push("faces");
    }
    if opts.clip {
        steps.push("clip");
    }
    if opts.ai {
        steps.push("ollama");
        steps.push("model");
    }
    steps.into_iter().map(String::from).collect()
}

#[tauri::command]
fn start_install(app: AppHandle, options: InstallOptions) -> Vec<String> {
    CANCEL.store(false, Ordering::Release);
    let steps = plan(&options);
    *OPTIONS.lock().unwrap() = Some(options.clone());
    spawn_steps(app, steps.clone(), options);
    steps
}

// Retries a failed step, and the steps that waited for it
#[tauri::command]
fn retry_step(app: AppHandle, step: String) -> Result<(), String> {
    let options = OPTIONS.lock().unwrap().clone().ok_or("Nothing to retry")?;
    CANCEL.store(false, Ordering::Release);
    let mut steps = vec![step.clone()];
    let follow: &[&str] = match step.as_str() {
        "lumina" => &["faces", "clip", "ollama", "model"],
        "ollama" => &["model"],
        _ => &[],
    };
    let planned = plan(&options);
    steps.extend(planned.into_iter().filter(|s| follow.contains(&s.as_str())));
    spawn_steps(app, steps, options);
    Ok(())
}

#[tauri::command]
fn cancel_install() {
    CANCEL.store(true, Ordering::Release);
}

#[tauri::command]
fn launch_lumina(app: AppHandle, dir: String) -> Result<(), String> {
    Command::new(Path::new(&dir).join("Lumina.exe")).spawn().map_err(|e| format!("Couldn't open Lumina: {e}"))?;
    app.exit(0);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            system_info,
            free_space,
            pick_folder,
            start_install,
            retry_step,
            cancel_install,
            launch_lumina
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lumina Setup");
}
