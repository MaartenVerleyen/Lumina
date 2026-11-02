// Bringing one library up to date, the way the desktop app does it when a folder opens, one step after
// the other: index the files, thumbnails and video frames, faces, eyes and focus, smart search, and
// captions when a caption model is configured. Every step only does what is still missing.
use crate::host::ServerHost;
use lumina_core::host::SharedHost;
use lumina_core::{ai, clip, db, face_engine, face_ort, face_quality, face_scan, scan, thumbs};
use serde_json::Value as JsonValue;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::{error::RecvError, Receiver};

pub struct Pipeline {
    pub host: Arc<ServerHost>,
    pub caption_model: Option<String>,
}

// Waits for `event` with a payload that `finished` accepts (events from before the subscription are missed,
// so subscribe before starting the step)
async fn wait_for(rx: &mut Receiver<(String, JsonValue)>, event: &str, finished: impl Fn(&JsonValue) -> bool) {
    loop {
        match rx.recv().await {
            Ok((name, payload)) if name == event && finished(&payload) => return,
            Err(RecvError::Closed) => return,
            _ => {}
        }
    }
}

fn done(p: &JsonValue) -> bool {
    p["done"].as_bool() == Some(true)
}

impl Pipeline {
    fn shared(&self) -> SharedHost {
        self.host.clone()
    }

    pub async fn update_library(&self, root: &str) -> Result<(), String> {
        let started = Instant::now();
        println!("[library] {root}: indexing");
        let photos = scan::scan_folder(self.shared(), root.to_string(), None).await?;
        while thumbs::thumbnail_passes_running() {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }

        // A Live Photo's clip is shown and scanned with its photo
        let live_clips: HashSet<&str> =
            photos.iter().filter(|p| p.live_photo_hash.is_some()).map(|p| p.hash.as_str()).collect();
        let in_library: HashSet<&str> = photos.iter().map(|p| p.hash.as_str()).collect();
        let unscanned: Vec<String> = {
            let conn = db::open_global_db(&*self.host)?;
            let mut stmt = conn
                .prepare("SELECT hash FROM photos WHERE COALESCE(faces_engine, '') != ?1")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([face_engine::FACE_ENGINE_V2], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.flatten()
                .filter(|h| in_library.contains(h.as_str()) && !live_clips.contains(h.as_str()))
                .collect()
        };
        // One GPU for both: the caption model (6+ GB) and the face and smart search models (1-3 GB) take
        // turns rather than squeezing each other, which left Ollama with half its layers on the CPU
        if self.caption_model.is_some() {
            match ai::unload_loaded_models().await {
                Ok(models) if !models.is_empty() => println!("[library] unloaded {} from Ollama", models.join(", ")),
                Ok(_) => {}
                Err(e) => println!("[library] Ollama: {e}"),
            }
        }
        if !unscanned.is_empty() {
            println!("[library] {root}: faces in {} photos and videos", unscanned.len());
            let mut rx = self.host.subscribe();
            face_scan::scan_library_faces_batch(self.shared(), unscanned).await?;
            wait_for(&mut rx, "face-scan-progress", done).await;
        }

        let mut rx = self.host.subscribe();
        if face_quality::measure_face_quality(self.shared(), root.to_string()).await? > 0 {
            wait_for(&mut rx, "face-quality-progress", done).await;
        }

        let mut rx = self.host.subscribe();
        if clip::start_semantic_index(self.shared(), root.to_string()).await? > 0 {
            wait_for(&mut rx, "semantic-progress", |p| done(p) && p["stage"] == "index").await;
        }

        if let Some(model) = &self.caption_model {
            let uncaptioned: Vec<String> = photos
                .iter()
                .filter(|p| p.media_type != "video" && p.ai_caption.is_empty())
                .map(|p| p.hash.clone())
                .collect();
            if !uncaptioned.is_empty() {
                face_ort::release_models();
                println!("[library] {root}: captions for {} photos ({model})", uncaptioned.len());
                let summary = ai::run_caption_batch(self.shared(), uncaptioned, model.clone()).await?;
                if !summary.failures.is_empty() {
                    println!("[library] {} captions failed, first: {}", summary.failures.len(), summary.failures[0].error);
                }
            }
        }
        println!("[library] {root}: up to date ({} files, {:.1} s)", photos.len(), started.elapsed().as_secs_f64());
        Ok(())
    }
}
