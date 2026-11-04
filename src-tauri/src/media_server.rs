// Linux only: WebKitGTK can't stream videos from Tauri's asset:// URLs (tauri#3725), so the window plays
// local videos over plain HTTP from 127.0.0.1 instead, with range requests like any web server. Windows
// keeps asset://, where WebView2 plays video. Only video files are served, only from the folders the
// asset protocol may already show (the opened libraries and the app's data folder), and only with this
// run's token, so another program or web page on the PC can't read files through it. A server's videos
// stall the same way on lumina-remote://, so they come through here as well (/remote), with the same token.

#[cfg(target_os = "linux")]
static ADDRESS: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();

// Where the window finds the video server: { base, token }, or null where there is none (Windows, or the
// port couldn't be opened, and videos go through asset:// as before)
#[tauri::command]
pub fn local_media_server() -> Option<serde_json::Value> {
    #[cfg(target_os = "linux")]
    if let Some((base, token)) = ADDRESS.get() {
        return Some(serde_json::json!({ "base": base, "token": token }));
    }
    None
}

#[cfg(target_os = "linux")]
pub fn start(app: tauri::AppHandle) {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();

    // A free port picked by the system, on loopback only
    let listener = match std::net::TcpListener::bind("127.0.0.1:0").and_then(|l| l.set_nonblocking(true).map(|_| l)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[media] no local video server ({e}); videos may not play");
            return;
        }
    };
    let Ok(addr) = listener.local_addr() else { return };
    let _ = ADDRESS.set((format!("http://{addr}"), token.clone()));

    let router = axum::Router::new()
        .route("/video/{token}", axum::routing::get(serve_video))
        .route("/remote/{token}", axum::routing::get(serve_remote_video))
        .with_state(Server { app, token });
    tauri::async_runtime::spawn(async move {
        match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => {
                if let Err(e) = axum::serve(listener, router).await {
                    eprintln!("[media] local video server stopped: {e}");
                }
            }
            Err(e) => eprintln!("[media] no local video server ({e})"),
        }
    });
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct Server {
    app: tauri::AppHandle,
    token: String,
}

// Containers the library treats as video (VIDEO_NAME in src/utils/media.ts), plus what playable copies use
#[cfg(target_os = "linux")]
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "3gp", "avi", "mts", "m2ts", "mpg", "mpeg", "webm", "mkv"];

#[cfg(target_os = "linux")]
fn may_serve(app: &tauri::AppHandle, path: &std::path::Path) -> bool {
    use std::path::Component;
    use tauri::Manager;
    let is_video = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()));
    // No "..": a path must name its file directly, the way the engine stores them
    let plain = path.is_absolute() && path.components().all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
    is_video && plain && path.is_file() && app.asset_protocol_scope().is_allowed(path)
}

#[cfg(target_os = "linux")]
async fn serve_video(
    axum::extract::State(server): axum::extract::State<Server>,
    axum::extract::Path(token): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
    request: axum::extract::Request,
) -> axum::response::Response {
    use axum::http::{header, HeaderValue, StatusCode};
    use axum::response::IntoResponse;
    use tower::ServiceExt;

    let Some(path) = query.get("path").map(std::path::PathBuf::from) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // The same answer for a wrong token and a file it may not serve: nothing to learn by probing
    if token != server.token || !may_serve(&server.app, &path) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match tower_http::services::ServeFile::new(&path).oneshot(request).await {
        Ok(response) => {
            let mut response = response.into_response();
            response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

// A server's video (?key=<server>/<kind>/<id>, as lumina-remote:// names it), fetched with this app's session
// and streamed through with its range, so the player can seek
#[cfg(target_os = "linux")]
async fn serve_remote_video(
    axum::extract::State(server): axum::extract::State<Server>,
    axum::extract::Path(token): axum::extract::Path<String>,
    axum::extract::Query(query): axum::extract::Query<std::collections::HashMap<String, String>>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    let Some(key) = query.get("key") else { return StatusCode::NOT_FOUND.into_response() };
    if token != server.token {
        return StatusCode::NOT_FOUND.into_response();
    }
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let resp = match crate::remote::video_response(&server.app, key, range).await {
        Ok(resp) => resp,
        Err(status) => return StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY).into_response(),
    };
    let mut builder = axum::http::Response::builder().status(resp.status()).header(header::CACHE_CONTROL, "no-store");
    for name in [header::CONTENT_TYPE, header::CONTENT_LENGTH, header::CONTENT_RANGE, header::ACCEPT_RANGES] {
        if let Some(value) = resp.headers().get(&name) {
            builder = builder.header(name, value.clone());
        }
    }
    builder
        .body(axum::body::Body::from_stream(resp.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
