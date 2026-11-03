// Bringing one library up to date, the way the desktop app does it when a folder opens, one step after
// the other: index the files, thumbnails and video frames, faces, eyes and focus, smart search, and
// captions when a caption model is configured. Every step only does what is still missing.
use crate::host::ServerHost;
use lumina_core::host::SharedHost;
use lumina_core::types::PhotoItem;
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

// Work asked for from the admin page. The serve loop runs it between its own passes, one job at a time, so
// it never races the watcher's updates for the GPU or the engine's process-wide job flags.
#[derive(Clone, Debug)]
pub enum Job {
    // Walk the library again, and do whatever is missing after (as on a change in the folder)
    Update(String),
    Faces(String),
    SmartSearch(String),
    Captions(String),
}

impl Job {
    pub fn parse(kind: &str, root: String) -> Result<Job, String> {
        match kind {
            "rescan" => Ok(Job::Update(root)),
            "faces" => Ok(Job::Faces(root)),
            "smart_search" => Ok(Job::SmartSearch(root)),
            "captions" => Ok(Job::Captions(root)),
            other => Err(format!("Unknown job \"{other}\": rescan, faces, smart_search or captions")),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Job::Update(r) => format!("Rescan of {r}"),
            Job::Faces(r) => format!("Face scan of {r}"),
            Job::SmartSearch(r) => format!("Smart search index of {r}"),
            Job::Captions(r) => format!("Captions for {r}"),
        }
    }
}

// What the pipeline is doing and what waits: the admin page shows it
#[derive(Default)]
pub struct Board {
    pub current: Option<String>,
    pub queued: Vec<String>,
}

pub struct Jobs {
    // The caption model the pipeline uses (shown on the admin page)
    pub caption_model: std::sync::Mutex<Option<String>>,
    sender: tokio::sync::mpsc::UnboundedSender<Job>,
    receiver: std::sync::Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<Job>>>,
    pub board: std::sync::Mutex<Board>,
}

impl Default for Jobs {
    fn default() -> Jobs {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        Jobs { caption_model: Default::default(), sender, receiver: std::sync::Mutex::new(Some(receiver)), board: Default::default() }
    }
}

impl Jobs {
    pub fn set_caption_model(&self, model: Option<String>) {
        *self.caption_model.lock().unwrap() = model;
    }

    pub fn queue(&self, job: Job) -> Result<(), String> {
        self.board.lock().unwrap().queued.push(job.describe());
        self.sender.send(job).map_err(|_| "The server isn't running its pipeline (start it with `serve`)".to_string())
    }

    // The serve loop takes the receiving end once
    pub fn take_receiver(&self) -> Option<tokio::sync::mpsc::UnboundedReceiver<Job>> {
        self.receiver.lock().unwrap().take()
    }

    pub fn started(&self, what: String) {
        let mut board = self.board.lock().unwrap();
        if let Some(i) = board.queued.iter().position(|q| *q == what) {
            board.queued.remove(i);
        }
        board.current = Some(what);
    }

    pub fn finished(&self) {
        self.board.lock().unwrap().current = None;
    }
}

impl Pipeline {
    fn shared(&self) -> SharedHost {
        self.host.clone()
    }

    // Runs one job from the admin page
    pub async fn run(&self, job: Job) -> Result<(), String> {
        let jobs = &self.host.jobs;
        jobs.started(job.describe());
        let result = match &job {
            Job::Update(root) => self.update_library(root).await,
            Job::Faces(root) => {
                let photos = scan::list_library(self.shared(), root.clone()).await?;
                self.make_room_for_onnx().await;
                self.faces(root, &photos).await
            }
            Job::SmartSearch(root) => {
                self.make_room_for_onnx().await;
                self.smart_search(root).await
            }
            Job::Captions(root) => {
                let photos = scan::list_library(self.shared(), root.clone()).await?;
                self.captions(root, &photos).await
            }
        };
        jobs.finished();
        result
    }

    // One GPU for both: the caption model (6+ GB) and the face and smart search models (1-3 GB) take turns
    // rather than squeezing each other, which left Ollama with half its layers on the CPU
    async fn make_room_for_onnx(&self) {
        if self.caption_model.is_none() {
            return;
        }
        match ai::unload_loaded_models().await {
            Ok(models) if !models.is_empty() => println!("[library] unloaded {} from Ollama", models.join(", ")),
            Ok(_) => {}
            Err(e) => println!("[library] Ollama: {e}"),
        }
    }

    pub async fn update_library(&self, root: &str) -> Result<(), String> {
        let started = Instant::now();
        self.host.jobs.started(format!("Update of {root}"));
        let result = self.update_steps(root).await;
        self.host.jobs.finished();
        if result.is_ok() {
            println!("[library] {root}: up to date ({:.1} s)", started.elapsed().as_secs_f64());
        }
        result
    }

    async fn update_steps(&self, root: &str) -> Result<(), String> {
        println!("[library] {root}: indexing");
        let photos = scan::scan_folder(self.shared(), root.to_string(), None).await?;
        while thumbs::thumbnail_passes_running() {
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        self.make_room_for_onnx().await;
        self.faces(root, &photos).await?;
        self.smart_search(root).await?;
        if self.caption_model.is_some() {
            self.captions(root, &photos).await?;
        }
        Ok(())
    }

    // Faces in what hasn't been scanned with the current engine, then eyes and focus
    async fn faces(&self, root: &str, photos: &[PhotoItem]) -> Result<(), String> {
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
        Ok(())
    }

    async fn smart_search(&self, root: &str) -> Result<(), String> {
        let mut rx = self.host.subscribe();
        if clip::start_semantic_index(self.shared(), root.to_string()).await? > 0 {
            wait_for(&mut rx, "semantic-progress", |p| done(p) && p["stage"] == "index").await;
        }
        Ok(())
    }

    // Captions for photos without one, when a caption model is configured
    async fn captions(&self, root: &str, photos: &[PhotoItem]) -> Result<(), String> {
        let Some(model) = &self.caption_model else {
            return Err("No caption model is configured (caption_model, or LUMINA_CAPTION_MODEL)".into());
        };
        let uncaptioned: Vec<String> = photos
            .iter()
            .filter(|p| p.media_type != "video" && p.ai_caption.is_empty())
            .map(|p| p.hash.clone())
            .collect();
        if uncaptioned.is_empty() {
            return Ok(());
        }
        face_ort::release_models();
        println!("[library] {root}: captions for {} photos ({model})", uncaptioned.len());
        let summary = ai::run_caption_batch(self.shared(), uncaptioned, model.clone()).await?;
        if !summary.failures.is_empty() {
            println!("[library] {} captions failed, first: {}", summary.failures.len(), summary.failures[0].error);
        }
        Ok(())
    }
}
