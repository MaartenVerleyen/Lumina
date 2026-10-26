use crate::*;

// ----------------- OLLAMA LIFECYCLE -----------------

#[tauri::command]
pub async fn check_ollama_status() -> Result<OllamaStatus, String> {
    let res = FAST_STATUS_CLIENT.get("http://127.0.0.1:11434/api/tags").send().await;

    if res.is_err() {
        return Ok(OllamaStatus {
            running: false,
            active_vram_model: None,
            installed_models: Vec::new(),
        });
    }

    let mut installed_models = Vec::new();
    if let Ok(response) = res.unwrap().json::<serde_json::Value>().await {
        if let Some(models) = response["models"].as_array() {
            for m in models {
                let name = m["name"].as_str().unwrap_or_default().to_string();
                let size_bytes = m["size"].as_f64().unwrap_or(0.0);
                installed_models.push(OllamaModelInfo {
                    name,
                    size_gb: (size_bytes / (1024.0 * 1024.0 * 1024.0) * 10.0).round() / 10.0,
                });
            }
        }
    }

    let mut active_vram_model = None;
    if let Ok(ps_res) = FAST_STATUS_CLIENT.get("http://127.0.0.1:11434/api/ps").send().await {
        if let Ok(ps_val) = ps_res.json::<serde_json::Value>().await {
            if let Some(active_arr) = ps_val["models"].as_array() {
                if let Some(first) = active_arr.first() {
                    active_vram_model = first["name"].as_str().map(|s| s.to_string());
                }
            }
        }
    }

    Ok(OllamaStatus {
        running: true,
        active_vram_model,
        installed_models,
    })
}

// Flash attention makes qwen3-vl about 10-15% faster with identical output (measured 2026-10-27), but Ollama
// leaves it off unless OLLAMA_FLASH_ATTENTION is set. A user's own value always wins.
const FLASH_ATTENTION_VAR: &str = "OLLAMA_FLASH_ATTENTION";

fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn ollama_serve_command() -> std::process::Command {
    let mut cmd = hidden_command("ollama");
    cmd.arg("serve");
    if std::env::var_os(FLASH_ATTENTION_VAR).is_none() {
        cmd.env(FLASH_ATTENTION_VAR, "1");
    }
    cmd
}

#[tauri::command]
pub async fn start_ollama_service() -> Result<String, String> {
    ollama_serve_command()
        .spawn()
        .map_err(|e| format!("Failed to spawn ollama serve: {e}"))?;
    Ok("Ollama started in background".to_string())
}

#[derive(Serialize)]
pub struct OllamaTuningStatus {
    // The saved Windows user setting (or Lumina's own environment); None = not set, so Ollama runs without it
    pub flash_attention: Option<String>,
    // Lumina can change and apply the setting (Windows only)
    pub can_enable: bool,
}

// The user's saved environment variable (HKCU\Environment), which a restarted Ollama tray app picks up
fn user_env_var(name: &str) -> Option<String> {
    let out = hidden_command("reg").args(["query", "HKCU\\Environment", "/v", name]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    // "    OLLAMA_FLASH_ATTENTION    REG_SZ    1"
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.trim_start().starts_with(name))
        .and_then(|l| l.split_whitespace().nth(2).map(|v| v.to_string()))
}

#[tauri::command]
pub async fn ollama_tuning_status() -> OllamaTuningStatus {
    let can_enable = cfg!(target_os = "windows");
    let flash_attention = tauri::async_runtime::spawn_blocking(move || {
        if can_enable { user_env_var(FLASH_ATTENTION_VAR) } else { None }
            .or_else(|| std::env::var(FLASH_ATTENTION_VAR).ok())
    })
    .await
    .unwrap_or(None);
    OllamaTuningStatus { flash_attention, can_enable }
}

// Saves OLLAMA_FLASH_ATTENTION=1 for the Windows user and restarts Ollama so it takes effect now:
// the tray app (or a plain `ollama serve` if the tray app isn't installed) comes back with the setting on.
#[tauri::command]
pub async fn enable_ollama_flash_attention() -> Result<(), String> {
    if !cfg!(target_os = "windows") {
        return Err("Set OLLAMA_FLASH_ATTENTION=1 in Ollama's environment and restart it.".into());
    }
    tauri::async_runtime::spawn_blocking(|| -> Result<(), String> {
        let saved = hidden_command("setx")
            .args([FLASH_ATTENTION_VAR, "1"])
            .output()
            .map_err(|e| format!("Could not save the setting: {e}"))?;
        if !saved.status.success() {
            return Err(format!("Could not save the setting: {}", String::from_utf8_lossy(&saved.stderr).trim()));
        }
        for image in ["ollama app.exe", "ollama.exe"] {
            let _ = hidden_command("taskkill").args(["/IM", image, "/F"]).output();
        }
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let tray_app = std::env::var_os("LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join("Programs").join("Ollama").join("ollama app.exe"))
            .filter(|p| p.exists());
        match tray_app {
            Some(app) => hidden_command(app).env(FLASH_ATTENTION_VAR, "1").spawn(),
            None => ollama_serve_command().env(FLASH_ATTENTION_VAR, "1").spawn(),
        }
        .map_err(|e| format!("Ollama could not be restarted: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    // Wait until Ollama answers again (it takes a few seconds)
    for _ in 0..40 {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if FAST_STATUS_CLIENT.get("http://127.0.0.1:11434/api/version").send().await.is_ok() {
            return Ok(());
        }
    }
    Err("The setting is saved, but Ollama didn't come back within 20 s. Start it from the tray menu.".into())
}

#[tauri::command]
pub async fn preload_ollama_vram(model_name: String) -> Result<String, String> {
    let payload = json!({
        "model": model_name.trim(),
        "prompt": "",
        "keep_alive": "30m"
    });

    let _ = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to warm up model in VRAM: {e}"))?;

    Ok("Model loaded into VRAM".to_string())
}

#[tauri::command]
pub async fn unload_ollama_vram(model_name: String) -> Result<String, String> {
    let payload = json!({
        "model": model_name,
        "keep_alive": 0
    });

    let _ = HTTP_CLIENT
        .post("http://127.0.0.1:11434/api/generate")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama: {e}"))?;

    Ok("Model unloaded from VRAM".to_string())
}

#[tauri::command]
pub async fn pull_ollama_model(app: AppHandle, model_name: String) -> Result<String, String> {
    let clean_model = model_name.trim().to_string();
    if clean_model.is_empty() {
        return Err("Model name cannot be empty".into());
    }

    let _ = app.emit(
        "ollama-pull-progress",
        OllamaPullProgress {
            model: clean_model.clone(),
            status: "Connecting to Ollama registry...".to_string(),
            completed_mb: 0.0,
            total_mb: 0.0,
            percent: 5,
            done: false,
        },
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3600))
        .build()
        .unwrap_or_default();

    let payload = json!({
        "name": clean_model,
        "stream": true
    });

    let mut res = client
        .post("http://127.0.0.1:11434/api/pull")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Failed to reach Ollama to download model: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Ollama pull failed with HTTP {}", res.status()));
    }

    let cancel_generation = PULL_CANCEL_GENERATION.load(Ordering::Acquire);
    let mut buffer = String::new();
    loop {
        // Dropping the request makes Ollama stop the download (it resumes from the partial files next time)
        let chunk = tokio::select! {
            c = res.chunk() => c,
            _ = wait_for_cancel(&PULL_CANCEL_GENERATION, &PULL_CANCEL_NOTIFY, cancel_generation) => {
                let _ = app.emit(
                    "ollama-pull-progress",
                    OllamaPullProgress {
                        model: clean_model.clone(),
                        status: "Cancelled".to_string(),
                        completed_mb: 0.0,
                        total_mb: 0.0,
                        percent: 0,
                        done: true,
                    },
                );
                return Err(PULL_CANCELLED.to_string());
            }
        };
        let Ok(Some(chunk)) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buffer.find('\n') {
            let line = buffer[..pos].trim().to_string();
            buffer = buffer[pos + 1..].to_string();
            if line.is_empty() {
                continue;
            }
            if let Ok(val) = serde_json::from_str::<JsonValue>(&line) {
                let status = val["status"].as_str().unwrap_or("Downloading...").to_string();
                let completed = val["completed"].as_f64().unwrap_or(0.0);
                let total = val["total"].as_f64().unwrap_or(0.0);
                let percent = if total > 0.0 {
                    ((completed / total) * 100.0).round() as usize
                } else {
                    15
                };
                let _ = app.emit(
                    "ollama-pull-progress",
                    OllamaPullProgress {
                        model: clean_model.clone(),
                        status,
                        completed_mb: (completed / (1024.0 * 1024.0) * 10.0).round() / 10.0,
                        total_mb: (total / (1024.0 * 1024.0) * 10.0).round() / 10.0,
                        percent: percent.min(99),
                        done: false,
                    },
                );
            }
        }
    }

    let _ = app.emit(
        "ollama-pull-progress",
        OllamaPullProgress {
            model: clean_model.clone(),
            status: "Ready".to_string(),
            completed_mb: 0.0,
            total_mb: 0.0,
            percent: 100,
            done: true,
        },
    );

    Ok(format!("Successfully installed {}", clean_model))
}

// ----------------- FAST ASSISTANT-PREFILLED QWEN3-VL VISION PIPELINE -----------------

// Ollama resizes every image to a fixed working size for qwen3-vl (~1,070 prompt tokens): up to ~900 px the
// model's cost does not change, larger costs more tokens without reading better (measured 2026-10-25).
// So 896 px is the most detail (OCR!) at the lowest cost; the old 360px thumbnail misread text.
pub const AI_IMAGE_EDGE: u32 = 896;

// Base64 AI images prepared ahead of time (the next photo is encoded while the current one is analysed)
static AI_IMAGE_CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
const AI_IMAGE_CACHE_MAX: usize = 8;

// Builds the 896px JPEG (q90) the model sees, from the best available source: the cached 1920px preview
// for RAW/HEIC, otherwise the original (big JPEGs decode near the target size directly).
pub fn encode_ai_image(app: &AppHandle, hash: &str, image_path: &str) -> Result<String, String> {
    let preview = get_app_storage_dir(app)
        .join("previews")
        .join(format!("{hash}_preview.jpg"));
    let img = if preview.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
        image::open(&preview).map_err(|e| e.to_string())?
    } else {
        open_and_orient_image_sized(Path::new(image_path), AI_IMAGE_EDGE)?
    };
    let small = img.thumbnail(AI_IMAGE_EDGE, AI_IMAGE_EDGE).to_rgb8();
    let mut buf = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90)
        .encode_image(&small)
        .map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(buf.into_inner()))
}

fn take_cached_ai_image(hash: &str) -> Option<String> {
    AI_IMAGE_CACHE.lock().ok()?.remove(hash)
}

// Prefetch: the batch runner calls this for the next photo while the current one is in Ollama
#[tauri::command]
pub async fn prepare_ai_image(app: AppHandle, hash: String, image_path: String) -> Result<(), String> {
    if AI_IMAGE_CACHE.lock().map(|c| c.contains_key(&hash)).unwrap_or(false) {
        return Ok(());
    }
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        encode_ai_image(&app, &hash, &image_path).map(|b64| (hash, b64))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Ok(mut cache) = AI_IMAGE_CACHE.lock() {
        if cache.len() >= AI_IMAGE_CACHE_MAX {
            cache.clear();
        }
        cache.insert(encoded.0, encoded.1);
    }
    Ok(())
}

// Smallest context that fits the ~1,100 prompt tokens + capped output (measured: same speed as 8192)
const AI_MIN_CTX: u64 = 4096;

// Context size for the request. Ollama reloads the model (~4-6 s) whenever a request asks for a different
// context than the loaded model has, so reuse whatever is loaded (e.g. a user-configured 8k default) as long
// as it is large enough; only ask for AI_MIN_CTX when the model isn't loaded yet or has less.
async fn ai_context_size(model: &str) -> u64 {
    let loaded = async {
        let ps: JsonValue = FAST_STATUS_CLIENT
            .get("http://127.0.0.1:11434/api/ps")
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        ps["models"]
            .as_array()?
            .iter()
            .find(|m| m["name"].as_str() == Some(model) || m["model"].as_str() == Some(model))?["context_length"]
            .as_u64()
    }
    .await;
    match loaded {
        Some(ctx) if ctx >= AI_MIN_CTX => ctx,
        _ => AI_MIN_CTX,
    }
}

// Error text the UI recognises as "stopped by the user" (not a failure to retry or report)
pub const AI_CANCELLED: &str = "AI analysis cancelled";

// Stop button: bumping the generation makes every in-flight ai_analyze_photo abort its Ollama request
// (dropping the HTTP request makes Ollama stop generating)
static AI_CANCEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static AI_CANCEL_NOTIFY: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

#[tauri::command]
pub fn cancel_ai_analysis() {
    AI_CANCEL_GENERATION.fetch_add(1, Ordering::AcqRel);
    AI_CANCEL_NOTIFY.notify_waiters();
    if let Ok(mut cache) = AI_IMAGE_CACHE.lock() {
        cache.clear();
    }
}

async fn wait_for_ai_cancel(started_generation: u64) {
    wait_for_cancel(&AI_CANCEL_GENERATION, &AI_CANCEL_NOTIFY, started_generation).await
}

// Resolves once `generation` moves past `started_generation` (a cancel command bumps it and notifies)
async fn wait_for_cancel(generation: &AtomicU64, notify: &tokio::sync::Notify, started_generation: u64) {
    loop {
        let notified = notify.notified();
        if generation.load(Ordering::Acquire) != started_generation {
            return;
        }
        notified.await;
    }
}

// Error text the UI recognises as "the user cancelled the model download"
pub const PULL_CANCELLED: &str = "Model download cancelled";
static PULL_CANCEL_GENERATION: AtomicU64 = AtomicU64::new(0);
static PULL_CANCEL_NOTIFY: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);

#[tauri::command]
pub fn cancel_ollama_pull() {
    PULL_CANCEL_GENERATION.fetch_add(1, Ordering::AcqRel);
    PULL_CANCEL_NOTIFY.notify_waiters();
}

// Prompt and schema tuned on 24 library photos (2026-10-25): v1 copied the caption into ocr_text on every
// photo without text and wrote 2-4 sentence captions. The schema limits are enforced by Ollama's grammar,
// which caps output length: ~70 instead of ~160 output tokens, +64% photos/minute.
const AI_PROMPT: &str = "Describe this photo for a photo library.\n\
- caption: one sentence, at most 20 words.\n\
- objects: 5 to 8 short lowercase tags (1-2 words each) for the main subjects, objects and setting.\n\
- scene: the best matching category.\n\
- ocr_text: copy text that is literally written in the image (signs, documents, screens). \
If no text is visible, return an empty string. Never describe the image here.";

pub fn json_value_to_string_list(val: Option<&JsonValue>) -> Vec<String> {
    let Some(v) = val else { return Vec::new() };
    match v {
        JsonValue::Array(arr) => arr
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(s) => Some(s.trim().to_string()),
                JsonValue::Object(map) => map
                    .get("name")
                    .or_else(|| map.get("label"))
                    .or_else(|| map.get("tag"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim().to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect(),
        JsonValue::String(s) => s
            .split(|c| c == ',' || c == ';' || c == '\n')
            .map(|part| part.trim().trim_matches(|c| c == '[' || c == ']' || c == '"').to_string())
            .filter(|part| !part.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

pub fn json_value_to_string(val: Option<&JsonValue>) -> String {
    let Some(v) = val else { return String::new() };
    match v {
        JsonValue::String(s) => s.trim().to_string(),
        JsonValue::Array(arr) => arr
            .iter()
            .filter_map(|x| x.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        _ => String::new(),
    }
}

pub fn parse_face_boxes(val: Option<&JsonValue>) -> Vec<AiFaceBox> {
    let Some(JsonValue::Array(arr)) = val else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        if let JsonValue::Object(map) = item {
            let coords_val = map
                .get("box_2d")
                .or_else(|| map.get("bbox"))
                .or_else(|| map.get("box"));
            if let Some(JsonValue::Array(c_arr)) = coords_val {
                let nums: Vec<f64> = c_arr.iter().filter_map(|n| n.as_f64()).collect();
                if nums.len() == 4 {
                    let label = map
                        .get("label")
                        .or_else(|| map.get("person"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string());
                    out.push(AiFaceBox { box_2d: nums, label });
                }
            }
        } else if let JsonValue::Array(c_arr) = item {
            let nums: Vec<f64> = c_arr.iter().filter_map(|n| n.as_f64()).collect();
            if nums.len() == 4 {
                out.push(AiFaceBox {
                    box_2d: nums,
                    label: None,
                });
            }
        }
    }
    out
}

pub fn parse_resilient_ai_json(raw: &str) -> Result<AiVisionResponse, String> {
    let mut cleaned = raw.trim().to_string();

    if let Some(end_think) = cleaned.rfind("</think>") {
        cleaned = cleaned[(end_think + 8)..].trim().to_string();
    }
    cleaned = cleaned
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();

    // Auto-repair truncated JSON if model hit token limit during long OCR text
    if cleaned.starts_with('{') && !cleaned.ends_with('}') {
        let quote_count = cleaned.chars().filter(|&c| c == '"').count();
        if quote_count % 2 != 0 {
            cleaned.push('"');
        }
        let open_brackets = cleaned.chars().filter(|&c| c == '[').count();
        let close_brackets = cleaned.chars().filter(|&c| c == ']').count();
        for _ in 0..open_brackets.saturating_sub(close_brackets) {
            cleaned.push(']');
        }
        cleaned.push('}');
    }

    let extract_from_obj = |val: &JsonValue| -> Option<AiVisionResponse> {
        let obj = val
            .get("analysis")
            .or_else(|| val.get("result"))
            .or_else(|| val.get("image"))
            .filter(|v| v.is_object())
            .unwrap_or(val);

        let objects = json_value_to_string_list(
            obj.get("objects")
                .or_else(|| obj.get("tags"))
                .or_else(|| obj.get("keywords"))
                .or_else(|| obj.get("labels"))
                .or_else(|| obj.get("items")),
        );
        let scene = json_value_to_string(
            obj.get("scene")
                .or_else(|| obj.get("setting"))
                .or_else(|| obj.get("category")),
        );
        let is_screenshot = obj
            .get("is_screenshot")
            .and_then(|v| v.as_bool())
            .unwrap_or_else(|| scene.to_lowercase().contains("screenshot"));
        let people_present = json_value_to_string_list(
            obj.get("people_present")
                .or_else(|| obj.get("people"))
                .or_else(|| obj.get("persons")),
        );
        let face_boxes = parse_face_boxes(
            obj.get("face_boxes")
                .or_else(|| obj.get("faces"))
                .or_else(|| obj.get("face_locations")),
        );
        let ocr_text = json_value_to_string(
            obj.get("ocr_text")
                .or_else(|| obj.get("text"))
                .or_else(|| obj.get("visible_text")),
        );
        let caption = json_value_to_string(
            obj.get("caption")
                .or_else(|| obj.get("description"))
                .or_else(|| obj.get("summary"))
                .or_else(|| obj.get("title")),
        );

        if !caption.is_empty() || !objects.is_empty() || !ocr_text.is_empty() {
            Some(AiVisionResponse {
                objects,
                scene,
                is_screenshot,
                people_present,
                face_boxes,
                ocr_text,
                caption,
            })
        } else {
            None
        }
    };

    if let Ok(val) = serde_json::from_str::<JsonValue>(&cleaned) {
        if let Some(res) = extract_from_obj(&val) {
            return Ok(res);
        }
    }

    if let (Some(start_idx), Some(end_idx)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if start_idx < end_idx {
            if let Ok(val) = serde_json::from_str::<JsonValue>(&cleaned[start_idx..=end_idx]) {
                if let Some(res) = extract_from_obj(&val) {
                    return Ok(res);
                }
            }
        }
    }

    Err(format!(
        "Could not parse JSON from model output: {}",
        cleaned.chars().take(160).collect::<String>()
    ))
}

#[tauri::command]
pub async fn ai_analyze_photo(
    app: AppHandle,
    hash: String,
    image_path_for_ai: String,
    model_name: String,
    existing_tags: Vec<String>,
) -> Result<AiAnalysisResult, String> {
    let ai_started = Instant::now();
    let cancel_generation = AI_CANCEL_GENERATION.load(Ordering::Acquire);
    let base64_img = match take_cached_ai_image(&hash) {
        Some(prepared) => prepared,
        None => {
            let img_path_clone = image_path_for_ai.clone();
            let app_for_buf = app.clone();
            let hash_for_buf = hash.clone();
            tauri::async_runtime::spawn_blocking(move || {
                encode_ai_image(&app_for_buf, &hash_for_buf, &img_path_clone)
            })
            .await
            .map_err(|e| e.to_string())??
        }
    };
    let encode_ms = elapsed_ms(ai_started);
    let image_kb = base64_img.len() * 3 / 4 / 1024;

    // The caller passes the library's most frequent tags, so the same subject gets the same tag across photos
    let prompt = if existing_tags.is_empty() {
        AI_PROMPT.to_string()
    } else {
        format!(
            "{AI_PROMPT}\nPrefer these existing library tags when they fit: {}.",
            existing_tags.iter().take(40).cloned().collect::<Vec<_>>().join(", ")
        )
    };

    let schema = json!({
        "type": "object",
        "properties": {
            "caption": { "type": "string", "maxLength": 160 },
            "objects": {
                "type": "array",
                "items": { "type": "string", "maxLength": 24 },
                "minItems": 3,
                "maxItems": 8
            },
            "scene": {
                "type": "string",
                "enum": ["indoor", "outdoor", "screenshot", "document", "nature", "street", "beach", "kitchen", "studio", "night"]
            },
            "ocr_text": { "type": "string", "maxLength": 300 }
        },
        "required": ["caption", "objects", "scene", "ocr_text"]
    });

    let num_ctx = ai_context_size(model_name.trim()).await;

    // Closed-think prefill keeps hybrid reasoning models from spending tokens on <think>
    let payload = json!({
        "model": model_name.trim(),
        "messages": [
            {
                "role": "user",
                "content": prompt,
                "images": [base64_img]
            },
            {
                "role": "assistant",
                "content": "<think>\n\n</think>\n\n"
            }
        ],
        "format": schema,
        "stream": false,
        "options": {
            "temperature": 0.1,
            "num_ctx": num_ctx,
            "num_predict": 512
        },
        "keep_alive": "30m"
    });

    let request_started = Instant::now();
    let request = async {
        let res = HTTP_CLIENT
            .post("http://127.0.0.1:11434/api/chat")
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("Ollama unreachable: {e}"))?;
        if !res.status().is_success() {
            let err = res.text().await.unwrap_or_default();
            return Err(format!("Ollama error: {err}"));
        }
        res.json::<JsonValue>().await.map_err(|e| e.to_string())
    };
    let body: JsonValue = tokio::select! {
        result = request => result?,
        _ = wait_for_ai_cancel(cancel_generation) => return Err(AI_CANCELLED.to_string()),
    };
    let request_ms = elapsed_ms(request_started);
    let post_started = Instant::now();
    let ns_to_ms = |key: &str| body[key].as_u64().unwrap_or(0) / 1_000_000;
    let mut perf = AiPerf {
        image_kb,
        encode_ms,
        request_ms,
        ollama_load_ms: ns_to_ms("load_duration"),
        prompt_tokens: body["prompt_eval_count"].as_u64().unwrap_or(0),
        prompt_eval_ms: ns_to_ms("prompt_eval_duration"),
        output_tokens: body["eval_count"].as_u64().unwrap_or(0),
        output_eval_ms: ns_to_ms("eval_duration"),
        ..Default::default()
    };
    let raw_content = body["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .trim();

    let ai_result = parse_resilient_ai_json(raw_content)?;

    // DB writes and ONNX face detection are blocking work: keep them off the async runtime threads
    let mut stored = tauri::async_runtime::spawn_blocking(move || store_ai_result(&app, &hash, ai_result))
    .await
    .map_err(|e| e.to_string())??;

    perf.post_ms = elapsed_ms(post_started);
    perf.total_ms = elapsed_ms(ai_started);
    stored.perf = perf;
    Ok(stored)
}

// The model sometimes "transcribes" the photo by repeating its own caption when there is no text
pub fn ocr_repeats_caption(ocr: &str, caption: &str) -> bool {
    let norm = |s: &str| {
        s.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let (o, c) = (norm(ocr), norm(caption));
    if o.is_empty() || c.is_empty() {
        return false;
    }
    let probe = |s: &str| s.chars().take(40).collect::<String>();
    c.contains(&probe(&o)) || o.contains(&probe(&c))
}

fn store_ai_result(app: &AppHandle, hash: &str, ai_result: AiVisionResponse) -> Result<AiAnalysisResult, String> {
    let mut conn = open_global_db(app)?;

    let banned_placeholders = [
        "none", "unknown", "null", "tag1", "tag2", "tag3", "object1", "object2", "item1", "item2",
        "analyze", "first", "got", "let", "step", "<lowercase noun>",
    ];

    let clean_caption = ai_result.caption.trim().to_string();
    let clean_ocr = if ai_result.ocr_text.contains("<transcribe")
        || ocr_repeats_caption(&ai_result.ocr_text, &clean_caption)
    {
        String::new()
    } else {
        ai_result.ocr_text.trim().to_string()
    };

    if let Ok(tx) = conn.transaction() {
        let _ = tx.execute(
            "DELETE FROM photo_tags WHERE hash = ?1 AND tag IN ('tag1', 'tag2', 'tag3', 'analyze', 'first', 'got', 'let', 'step')",
            params![hash],
        );

        for raw_tag in &ai_result.objects {
            let mut clean = raw_tag
                .trim()
                .trim_matches(|c| c == '<' || c == '>' || c == '"')
                .to_lowercase();
            for prefix in ["illustration of ", "picture of ", "photo of ", "image of "] {
                if let Some(stripped) = clean.strip_prefix(prefix) {
                    clean = stripped.trim().to_string();
                }
            }
            if clean.starts_with("text ") {
                continue;
            }
            if !clean.is_empty()
                && clean.len() <= 28
                && !clean.contains("lowercase")
                && !clean.contains('|')
                && !banned_placeholders.contains(&clean.as_str())
            {
                let _ = tx.execute(
                    "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)",
                    params![hash, clean],
                );
            }
        }

        if !ai_result.scene.is_empty() {
            let first_scene_word = ai_result
                .scene
                .split(|c: char| !c.is_alphanumeric())
                .find(|w| !w.is_empty())
                .unwrap_or("")
                .to_lowercase();
            if ["indoor", "outdoor", "screenshot", "document", "nature", "street", "beach", "kitchen", "studio", "night"]
                .contains(&first_scene_word.as_str())
            {
                let _ = tx.execute(
                    "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, ?2)",
                    params![hash, first_scene_word],
                );
            }
        }

        if ai_result.is_screenshot {
            let _ = tx.execute(
                "INSERT OR IGNORE INTO photo_tags (hash, tag) VALUES (?1, 'screenshot')",
                params![hash],
            );
        }

        let _ = tx.execute(
            "UPDATE photos SET ai_caption = ?1, ocr_text = ?2 WHERE hash = ?3",
            params![clean_caption, clean_ocr, hash],
        );

        let _ = tx.commit();
    }

    // Faces are no longer detected here: this ran on the 360px thumbnail, and its tiny, blurry crops were
    // stored as faces and weakened matching. "Scan Faces" detects them on a full-size decode instead.
    let current_faces = get_faces_for_hash(&conn, hash);
    let updated_tags = get_tags_for_hash(&conn, hash)?;

    let mut stmt = conn
        .prepare("SELECT person_name FROM photo_people WHERE hash = ?1 ORDER BY person_name ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![hash], |r| r.get(0)).map_err(|e| e.to_string())?;
    let updated_people: Vec<String> = rows.flatten().collect();

    Ok(AiAnalysisResult {
        tags: updated_tags,
        people: updated_people,
        faces: current_faces,
        caption: clean_caption,
        ocr_text: clean_ocr,
        perf: AiPerf::default(),
    })
}
