// Playable copies of videos WebView2 can't play itself (MTS/M2TS, AVI, MPEG, old MPEG-4): converted by ffmpeg
// to H.264 MP4 on demand, into `transcodes/{hash}.mp4`. ffmpeg is downloaded once, on first need, from one
// pinned release and checked against its SHA-256 before it is ever run.
use crate::*;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::io::BufRead;
use std::process::{Command, Stdio};

const FFMPEG_URL: &str =
    "https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip";
const FFMPEG_ZIP_SHA256: &str = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
const FFMPEG_ZIP_BYTES: u64 = 114_768_076;
const FFMPEG_ENTRY: &str = "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe";
const FFMPEG_SHA256: &str = "3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec";
const FFMPEG_FILE: &str = "ffmpeg-9.0.2.exe";

// Converted copies beyond this are removed, least recently played first
const CACHE_LIMIT_BYTES: u64 = 10 * 1024 * 1024 * 1024;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

static FFMPEG_VERIFIED: AtomicBool = AtomicBool::new(false);
static TRANSCODE_CANCEL: AtomicU64 = AtomicU64::new(0);
pub const TRANSCODE_CANCELLED: &str = "Conversion cancelled";

pub fn ffmpeg_path(app: &dyn Host) -> PathBuf {
    get_models_dir(app).join(FFMPEG_FILE)
}

pub fn transcodes_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("transcodes")
}

pub fn transcode_path(app_dir: &Path, hash: &str) -> PathBuf {
    transcodes_dir(app_dir).join(format!("{hash}.mp4"))
}

// ffmpeg is present at `path` and is the build that was checked (hashed once per run)
fn ffmpeg_ready(path: &Path) -> bool {
    if FFMPEG_VERIFIED.load(Ordering::Acquire) {
        return true;
    }
    let ok = sha256_hex(path).as_deref() == Some(FFMPEG_SHA256);
    FFMPEG_VERIFIED.store(ok, Ordering::Release);
    ok
}

#[derive(Serialize, Clone, Default)]
pub struct FfmpegDownloadProgress {
    pub downloaded_mb: f64,
    pub total_mb: f64,
    pub percent: usize,
    pub done: bool,
}

// Linux and macOS: no download, the system's ffmpeg is used (the server's Docker image includes it)
#[cfg(not(windows))]
async fn ensure_ffmpeg(_app: &dyn Host) -> Result<PathBuf, String> {
    system_ffmpeg().ok_or_else(|| "ffmpeg is not installed: install it with your package manager".to_string())
}

#[cfg(not(windows))]
pub fn system_ffmpeg() -> Option<PathBuf> {
    static FOUND: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
        let path = PathBuf::from(std::env::var_os("LUMINA_FFMPEG").unwrap_or_else(|| "ffmpeg".into()));
        let works = Command::new(&path)
            .arg("-version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        works.then_some(path)
    });
    FOUND.clone()
}

#[cfg(windows)]
async fn ensure_ffmpeg(app: &dyn Host) -> Result<PathBuf, String> {
    let target = ffmpeg_path(app);
    let check = target.clone();
    if tokio::task::spawn_blocking(move || ffmpeg_ready(&check)).await.unwrap_or(false) {
        return Ok(target);
    }
    let dir = get_models_dir(app);
    let zip_part = dir.join("ffmpeg.zip.part");
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client.get(FFMPEG_URL).send().await.map_err(|e| format!("Could not download ffmpeg: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Could not download ffmpeg: HTTP {}", res.status()));
    }
    let total = res.content_length().unwrap_or(FFMPEG_ZIP_BYTES);
    let mut file = File::create(&zip_part).map_err(|e| e.to_string())?;
    let (mut downloaded, mut last_percent) = (0u64, usize::MAX);
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("ffmpeg download interrupted: {e}"))? {
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        let percent = (downloaded * 100 / total.max(1)) as usize;
        if percent != last_percent {
            last_percent = percent;
            let _ = emit_to(&app, 
                "ffmpeg-download",
                FfmpegDownloadProgress {
                    downloaded_mb: (downloaded as f64 / 1_048_576.0 * 10.0).round() / 10.0,
                    total_mb: (total as f64 / 1_048_576.0 * 10.0).round() / 10.0,
                    percent: percent.min(99),
                    done: false,
                },
            );
        }
    }
    drop(file);

    let target_clone = target.clone();
    let installed = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let result = (|| {
            if sha256_hex(&zip_part).as_deref() != Some(FFMPEG_ZIP_SHA256) {
                return Err("The downloaded ffmpeg package failed its checksum. Please try again.".to_string());
            }
            let mut archive = zip::ZipArchive::new(BufReader::new(File::open(&zip_part).map_err(|e| e.to_string())?))
                .map_err(|e| format!("Corrupt ffmpeg package: {e}"))?;
            let part = target_clone.with_extension("exe.part");
            {
                let mut entry = archive.by_name(FFMPEG_ENTRY).map_err(|e| format!("ffmpeg missing from the package: {e}"))?;
                let mut out = File::create(&part).map_err(|e| e.to_string())?;
                std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            }
            if sha256_hex(&part).as_deref() != Some(FFMPEG_SHA256) {
                let _ = fs::remove_file(&part);
                return Err("ffmpeg failed its checksum".to_string());
            }
            fs::rename(&part, &target_clone).map_err(|e| e.to_string())
        })();
        let _ = fs::remove_file(&zip_part);
        result
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = emit_to(&app, "ffmpeg-download", FfmpegDownloadProgress { percent: 100, done: true, ..Default::default() });
    installed?;
    FFMPEG_VERIFIED.store(true, Ordering::Release);
    Ok(target)
}

pub(crate) fn ffmpeg_command(ffmpeg: &Path) -> Command {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[derive(Serialize, Clone)]
pub struct TranscodeProgress {
    pub hash: String,
    pub percent: usize,
    pub done: bool,
}

// Runs one conversion; Ok(false) when the encoder isn't in this ffmpeg build (the caller tries another)
fn run_conversion(
    app: &dyn Host,
    ffmpeg: &Path,
    source: &Path,
    out: &Path,
    encoder: &[&str],
    hash: &str,
    duration_ms: u64,
    generation: u64,
) -> Result<bool, String> {
    let mut child = ffmpeg_command(ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(source)
        // First video and (if any) audio stream; interlaced camcorder video (1080i) is deinterlaced
        .args(["-map", "0:v:0", "-map", "0:a:0?", "-vf", "yadif=deint=interlaced,scale=-2:'min(1080,ih)'"])
        .args(encoder)
        .args(["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart"])
        .args(["-progress", "pipe:1", "-nostats", "-f", "mp4"])
        .arg(out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start ffmpeg: {e}"))?;

    let stdout = child.stdout.take();
    let mut last_percent = usize::MAX;
    if let Some(stdout) = stdout {
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if TRANSCODE_CANCEL.load(Ordering::Acquire) != generation {
                let _ = child.kill();
                let _ = child.wait();
                return Err(TRANSCODE_CANCELLED.to_string());
            }
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<u64>().ok()) {
                let percent = ((us / 1000) * 100 / duration_ms.max(1)).min(99) as usize;
                if duration_ms > 0 && percent != last_percent {
                    last_percent = percent;
                    let _ = emit_to(&app, "transcode-progress", TranscodeProgress { hash: hash.to_string(), percent, done: false });
                }
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        return Ok(true);
    }
    let err = String::from_utf8_lossy(&output.stderr).to_string();
    if err.contains("Unknown encoder") || err.contains("Encoder not found") {
        return Ok(false);
    }
    Err(format!("ffmpeg could not convert this video: {}", err.lines().last().unwrap_or("unknown error")))
}

// Oldest-played copies go first once the cache is over its limit
fn prune_cache(dir: &Path, keep: &Path) {
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            m.is_file().then(|| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort();
    for (_, len, path) in files {
        if total <= CACHE_LIMIT_BYTES {
            break;
        }
        if path != keep && fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

// The playable copy of a video, if one was made before (marked as just used, for the cache's order)
pub fn existing_playable_copy(app: SharedHost, hash: String) -> Option<String> {
    let path = transcode_path(&get_app_storage_dir(&app), &hash);
    let file = File::options().write(true).open(&path).ok()?;
    let _ = file.set_modified(std::time::SystemTime::now());
    Some(path.to_string_lossy().to_string())
}

// Converts the video to an H.264 MP4 the app can play (downloading ffmpeg first if needed) and returns its path
pub async fn make_playable_copy(app: SharedHost, hash: String) -> Result<String, String> {
    if let Some(existing) = existing_playable_copy(app.clone(), hash.clone()) {
        return Ok(existing);
    }
    let generation = TRANSCODE_CANCEL.load(Ordering::Acquire);
    let (source, duration_ms): (String, Option<u64>) = {
        let conn = open_global_db(&app)?;
        conn.query_row("SELECT current_path, duration_ms FROM photos WHERE hash = ?1", params![hash], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(|_| "This video is no longer in the library".to_string())?
    };
    let ffmpeg = ensure_ffmpeg(&app).await?;
    if TRANSCODE_CANCEL.load(Ordering::Acquire) != generation {
        return Err(TRANSCODE_CANCELLED.to_string());
    }
    tokio::task::spawn_blocking(move || {
        let app_dir = get_app_storage_dir(&app);
        let dir = transcodes_dir(&app_dir);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = transcode_path(&app_dir, &hash);
        let part = dir.join(format!("{hash}.part.mp4"));
        let source = PathBuf::from(source);
        let duration = duration_ms.unwrap_or(0);
        // libx264 gives the best quality; Windows' own encoder is the fallback for a build without it
        let mut converted = false;
        for encoder in [&["-c:v", "libx264", "-preset", "veryfast", "-crf", "22"][..], &["-c:v", "h264_mf", "-b:v", "8M"][..]] {
            match run_conversion(&app, &ffmpeg, &source, &part, encoder, &hash, duration, generation) {
                Ok(true) => {
                    converted = true;
                    break;
                }
                Ok(false) => continue,
                Err(e) => {
                    let _ = fs::remove_file(&part);
                    let _ = emit_to(&app, "transcode-progress", TranscodeProgress { hash: hash.clone(), percent: 0, done: true });
                    return Err(e);
                }
            }
        }
        let _ = emit_to(&app, "transcode-progress", TranscodeProgress { hash: hash.clone(), percent: 100, done: true });
        if !converted {
            let _ = fs::remove_file(&part);
            return Err("This ffmpeg has no H.264 encoder".to_string());
        }
        fs::rename(&part, &out).map_err(|e| e.to_string())?;
        prune_cache(&dir, &out);
        Ok(out.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn cancel_playable_copy() {
    TRANSCODE_CANCEL.fetch_add(1, Ordering::AcqRel);
}

#[derive(Serialize)]
pub struct VideoCacheInfo {
    pub bytes: u64,
    pub files: usize,
    pub ffmpeg_installed: bool,
}

pub fn video_cache_info(app: SharedHost) -> VideoCacheInfo {
    let dir = transcodes_dir(&get_app_storage_dir(&app));
    let sizes: Vec<u64> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.metadata().ok().filter(|m| m.is_file()).map(|m| m.len()))
        .collect();
    VideoCacheInfo { bytes: sizes.iter().sum(), files: sizes.len(), ffmpeg_installed: ffmpeg_path(&app).exists() }
}

pub fn clear_video_cache(app: SharedHost) -> usize {
    let dir = transcodes_dir(&get_app_storage_dir(&app));
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| fs::remove_file(e.path()).is_ok())
        .count()
}

// Frames for a video Media Foundation can't open, when ffmpeg is installed (one frame, a second in, as the
// thumbnail); None without ffmpeg or when ffmpeg can't read it either
pub fn grab_frame_with_ffmpeg(ffmpeg: &Path, source: &Path, out: &Path) -> Option<DynamicImage> {
    let status = ffmpeg_command(ffmpeg)
        .args(["-y", "-ss", "1"])
        .arg("-i")
        .arg(source)
        .args(["-frames:v", "1", "-vf", "yadif=deint=interlaced,scale=640:-2", "-f", "image2", "-c:v", "mjpeg"])
        .arg(out)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        return None;
    }
    image::open(out).ok()
}

// The checked ffmpeg, if it is installed (for background work that must not start a download)
pub fn installed_ffmpeg(app: &dyn Host) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let _ = app;
        system_ffmpeg()
    }
    #[cfg(windows)]
    {
        let path = ffmpeg_path(app);
        ffmpeg_ready(&path).then_some(path)
    }
}
