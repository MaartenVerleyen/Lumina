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

#[tauri::command]
pub async fn start_ollama_service() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("ollama")
            .arg("serve")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to spawn ollama serve: {e}"))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("ollama")
            .arg("serve")
            .spawn()
            .map_err(|e| format!("Failed to spawn ollama serve: {e}"))?;
    }

    Ok("Ollama started in background".to_string())
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

    let mut buffer = String::new();
    while let Ok(Some(chunk)) = res.chunk().await {
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

pub fn encode_fast_ai_buffer(app: &AppHandle, hash: &str, image_path: &str) -> Result<String, String> {
    let orig_path = Path::new(image_path);
    // Phase 2 Fast Path: If not a screenshot and the pre-oriented 360px cached thumbnail exists,
    // read its raw JPEG bytes directly (<0.2ms) instead of decoding a 20MB+ camera image from disk!
    if !is_likely_screenshot(orig_path, "", None) {
        let thumb_path = get_app_storage_dir(app)
            .join("thumbnails")
            .join(format!("{}.jpg", hash));
        if let Ok(meta) = thumb_path.metadata() {
            if meta.len() > 512 {
                if let Ok(thumb_bytes) = fs::read(&thumb_path) {
                    return Ok(general_purpose::STANDARD.encode(&thumb_bytes));
                }
            }
        }
    }

    if let Ok(img) = open_and_orient_image(orig_path) {
        let small = img.thumbnail(640, 640).to_rgb8();
        let mut buf = Cursor::new(Vec::new());
        if small.write_to(&mut buf, ImageFormat::Jpeg).is_ok() {
            return Ok(general_purpose::STANDARD.encode(buf.into_inner()));
        }
    }
    let raw_bytes = fs::read(image_path).map_err(|e| format!("Failed to read image: {e}"))?;
    Ok(general_purpose::STANDARD.encode(&raw_bytes))
}

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
    let img_path_clone = image_path_for_ai.clone();
    let app_for_buf = app.clone();
    let hash_for_buf = hash.clone();
    let base64_img = tauri::async_runtime::spawn_blocking(move || {
        encode_fast_ai_buffer(&app_for_buf, &hash_for_buf, &img_path_clone)
    })
    .await
    .map_err(|e| e.to_string())??;
    let encode_ms = elapsed_ms(ai_started);
    let image_kb = base64_img.len() * 3 / 4 / 1024;

    let vocab_hint = if existing_tags.is_empty() {
        String::new()
    } else {
        format!(
            "Reuse relevant tags from [{}] when accurate. ",
            existing_tags.iter().take(20).cloned().collect::<Vec<_>>().join(", ")
        )
    };

    let prompt = format!(
        "Analyze this image. Keep ocr_text under 300 characters. {vocab_hint}"
    );

    let schema = json!({
        "type": "object",
        "properties": {
            "caption": { "type": "string", "description": "One concise sentence describing the photo" },
            "objects": {
                "type": "array",
                "items": { "type": "string" },
                "description": "5 to 10 short lowercase object/subject tags"
            },
            "scene": {
                "type": "string",
                "enum": ["indoor", "outdoor", "screenshot", "document", "nature", "street", "beach", "kitchen", "studio", "night"]
            },
            "is_screenshot": { "type": "boolean" },
            "ocr_text": { "type": "string", "description": "Main visible text in the image, max 300 chars, or empty string" }
        },
        "required": ["caption", "objects", "scene", "is_screenshot", "ocr_text"]
    });

    // Test 3 Winning Approach: Closed think prefill + schema + 8192 context window
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
            "num_ctx": 8192,
            "num_predict": 768
        },
        "keep_alive": "30m"
    });

    let request_started = Instant::now();
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

    let body: JsonValue = res.json().await.map_err(|e| e.to_string())?;
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
    let mut stored = tauri::async_runtime::spawn_blocking(move || {
        store_ai_result(&app, &hash, &image_path_for_ai, ai_result)
    })
    .await
    .map_err(|e| e.to_string())??;

    perf.post_ms = elapsed_ms(post_started);
    perf.total_ms = elapsed_ms(ai_started);
    stored.perf = perf;
    Ok(stored)
}

fn store_ai_result(
    app: &AppHandle,
    hash: &str,
    image_path_for_ai: &str,
    ai_result: AiVisionResponse,
) -> Result<AiAnalysisResult, String> {
    let mut conn = open_global_db(app)?;

    let banned_placeholders = [
        "none", "unknown", "null", "tag1", "tag2", "tag3", "object1", "object2", "item1", "item2",
        "analyze", "first", "got", "let", "step", "<lowercase noun>",
    ];

    let clean_ocr = if ai_result.ocr_text.contains("<transcribe") {
        String::new()
    } else {
        ai_result.ocr_text.trim().to_string()
    };
    let clean_caption = ai_result.caption.trim().to_string();

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

    if get_faces_for_hash(&conn, hash).is_empty() {
        let thumb_candidate = get_app_storage_dir(app)
            .join("thumbnails")
            .join(format!("{}.jpg", hash));
        let face_load_path = if thumb_candidate.exists() {
            thumb_candidate
        } else {
            PathBuf::from(image_path_for_ai)
        };
        if let Ok(img) = open_and_orient_image(&face_load_path) {
            let onnx_boxes = detect_faces_with_onnx(app, &img);
            for (bx, by, bw, bh, _score) in onnx_boxes {
                let _ = save_cropped_face_and_record(app, &conn, hash, &img, (bx, by, bw, bh), None, "onnx");
            }
        }
    }

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
