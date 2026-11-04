// The transfer protocol against a stand-in server that keeps everything in memory and can lose an answer
use super::*;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Fake {
    // Content hashes the server already has
    has: Mutex<Vec<String>>,
    uploads: Mutex<HashMap<String, (u64, String, Vec<u8>)>>,
    finished: Mutex<Vec<Vec<u8>>>,
    // The next chunk is saved but its answer is lost
    drop_answer: AtomicBool,
    // The next start answers "received: 0" although part of the file arrived
    forget_offset: AtomicBool,
    chunks: AtomicU64,
    file: Mutex<Vec<u8>>,
    wrong_blake3: AtomicBool,
}
type S = Arc<Fake>;

async fn check(State(s): State<S>, Json(body): Json<Value>) -> Json<Value> {
    let has = s.has.lock().unwrap();
    let missing: Vec<&str> =
        body["files"].as_array().unwrap().iter().filter_map(|f| f["hash"].as_str()).filter(|h| !has.iter().any(|x| x == h)).collect();
    Json(json!({ "missing": missing }))
}

async fn start(State(s): State<S>, Json(body): Json<Value>) -> Json<Value> {
    let full = body["full_hash"].as_str().unwrap().to_string();
    let mut uploads = s.uploads.lock().unwrap();
    if let Some((id, (_, _, data))) = uploads.iter().find(|(_, u)| u.1 == full) {
        let received = if s.forget_offset.swap(false, Ordering::SeqCst) { 0 } else { data.len() };
        return Json(json!({ "id": id, "received": received }));
    }
    let id = format!("u{}", uploads.len());
    uploads.insert(id.clone(), (body["size"].as_u64().unwrap(), full, Vec::new()));
    Json(json!({ "id": id, "received": 0 }))
}

async fn chunk(State(s): State<S>, UrlPath(id): UrlPath<String>, headers: HeaderMap, body: Bytes) -> axum::response::Response {
    let offset: usize = headers["upload-offset"].to_str().unwrap().parse().unwrap();
    let mut uploads = s.uploads.lock().unwrap();
    let data = &mut uploads.get_mut(&id).unwrap().2;
    if offset != data.len() {
        return (StatusCode::CONFLICT, Json(json!({ "error": "wrong offset", "offset": data.len() }))).into_response();
    }
    data.extend_from_slice(&body);
    s.chunks.fetch_add(1, Ordering::SeqCst);
    if s.drop_answer.swap(false, Ordering::SeqCst) {
        return (StatusCode::BAD_GATEWAY, "lost").into_response();
    }
    Json(json!({ "received": data.len() })).into_response()
}

async fn finish(State(s): State<S>, UrlPath(id): UrlPath<String>) -> axum::response::Response {
    let (size, full, data) = s.uploads.lock().unwrap().remove(&id).unwrap();
    if data.len() as u64 != size || blake3::hash(&data).to_hex().to_string() != full {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(json!({ "error": "BLAKE3 differs" }))).into_response();
    }
    s.finished.lock().unwrap().push(data);
    Json(json!({ "hash": "abc", "name": "a.jpg" })).into_response()
}

async fn download(State(s): State<S>, headers: HeaderMap) -> axum::response::Response {
    let file = s.file.lock().unwrap().clone();
    let blake = if s.wrong_blake3.load(Ordering::SeqCst) { "0".repeat(64) } else { blake3::hash(&file).to_hex().to_string() };
    let start: usize =
        headers.get("range").and_then(|r| r.to_str().ok()?.strip_prefix("bytes=")?.trim_end_matches('-').parse().ok()).unwrap_or(0);
    let status = if start > 0 { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
    let disposition = "attachment; filename=\"x.jpg\"; filename*=UTF-8''%C3%A9t%C3%A9.jpg".to_string();
    (status, [("content-disposition", disposition), ("x-lumina-blake3", blake)], file[start..].to_vec()).into_response()
}

async fn serve() -> (Conn, S) {
    let s: S = Arc::new(Fake::default());
    let app = Router::new()
        .route("/api/upload/check", post(check))
        .route("/api/upload", post(start))
        .route("/api/upload/{id}", put(chunk))
        .route("/api/upload/{id}/finish", post(finish))
        .route("/media/download/{hash}", get(download))
        .layer(axum::extract::DefaultBodyLimit::max(CHUNK as usize + 1024))
        .with_state(s.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (Conn { http: reqwest::Client::new(), base: format!("http://{addr}"), token: "t".into() }, s)
}

fn temp_file(name: &str, len: usize) -> (PathBuf, Vec<u8>) {
    let dir = std::env::temp_dir().join(format!("lumina-transfer-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let data: Vec<u8> = (0..len).map(|i| (i * 7 % 251) as u8).collect();
    let path = dir.join(name);
    fs::write(&path, &data).unwrap();
    (path, data)
}

async fn send(conn: &Conn, path: &Path) -> Result<Value, Failure> {
    let (hash, full, size) = hash_file(path).unwrap();
    let file = UploadFile { path, name: "a.jpg", size, hash: &hash, full_hash: &full, modified: 0 };
    upload_one(conn, &file, &AtomicU64::new(0), &AtomicBool::new(false), "test").await
}

// The web client computes the same content hash in the browser (src/api/webUpload.ts, tests/webUpload.test.ts
// checks these values): small, middle-sized and large files take different paths
#[test]
fn content_hashes_the_web_client_must_match() {
    for (len, expected) in [(1000usize, "bd91fa512b0279ff"), (100_000, "0e9c6db44d423af1"), (300_000, "a234c95ba48f1e05")] {
        let (path, _) = temp_file(&format!("ch-{len}.bin"), len);
        assert_eq!(hash_file(&path).unwrap().0, expected);
    }
}

#[tokio::test]
async fn a_file_goes_up_in_chunks_and_arrives_whole() {
    let (conn, s) = serve().await;
    let (path, data) = temp_file("whole.jpg", (CHUNK * 2 + 1234) as usize);
    assert_eq!(send(&conn, &path).await.unwrap()["hash"], "abc");
    assert_eq!(s.chunks.load(Ordering::SeqCst), 3);
    assert_eq!(s.finished.lock().unwrap()[0], data);
}

#[tokio::test]
async fn a_lost_answer_resumes_where_the_server_stands() {
    let (conn, s) = serve().await;
    let (path, data) = temp_file("resume.jpg", (CHUNK * 2 + 10) as usize);
    s.drop_answer.store(true, Ordering::SeqCst);
    // The first chunk arrived, its answer didn't: the queue tries again later
    assert!(matches!(send(&conn, &path).await, Err(Failure::Network(_))));
    assert_eq!(s.chunks.load(Ordering::SeqCst), 1);
    // Started again, the server says where it stands and only the rest is sent
    send(&conn, &path).await.unwrap();
    assert_eq!(s.chunks.load(Ordering::SeqCst), 3);
    assert_eq!(s.finished.lock().unwrap()[0], data);
}

#[tokio::test]
async fn a_chunk_at_the_wrong_offset_follows_the_server() {
    let (conn, s) = serve().await;
    let (path, data) = temp_file("offset.jpg", (CHUNK + 10) as usize);
    s.drop_answer.store(true, Ordering::SeqCst);
    assert!(send(&conn, &path).await.is_err());
    // The server answers "received 0" but has the first chunk: its 409 puts the client right
    s.forget_offset.store(true, Ordering::SeqCst);
    send(&conn, &path).await.unwrap();
    assert_eq!(s.finished.lock().unwrap()[0], data);
}

#[tokio::test]
async fn check_reports_only_what_the_server_lacks() {
    let (conn, s) = serve().await;
    s.has.lock().unwrap().push("aaaaaaaaaaaaaaaa".into());
    let files = [("aaaaaaaaaaaaaaaa".to_string(), 1, "a.jpg".to_string()), ("bbbbbbbbbbbbbbbb".to_string(), 1, "b.jpg".to_string())];
    assert_eq!(check_missing(&conn, &files).await.unwrap(), vec!["bbbbbbbbbbbbbbbb".to_string()]);
}

#[tokio::test]
async fn a_download_resumes_and_is_checked() {
    let (conn, s) = serve().await;
    let (src, data) = temp_file("dl-source.jpg", 300_000);
    *s.file.lock().unwrap() = data.clone();
    let dir = src.parent().unwrap().join("out");
    fs::create_dir_all(&dir).unwrap();
    // Half of it arrived before the connection dropped
    fs::write(dir.join(".lumina-h1.part"), &data[..150_000]).unwrap();
    let (saved, size) = download_one(&conn, "h1", &dir, &AtomicU64::new(0), &AtomicBool::new(false)).await.unwrap();
    assert_eq!(saved, dir.join("été.jpg"));
    assert_eq!(size, 300_000);
    assert_eq!(fs::read(&saved).unwrap(), data);
    // The same name again gets a number
    let (second, _) = download_one(&conn, "h1", &dir, &AtomicU64::new(0), &AtomicBool::new(false)).await.unwrap();
    assert_eq!(second, dir.join("été (2).jpg"));
    // A file that doesn't match the server's BLAKE3 is not kept
    s.wrong_blake3.store(true, Ordering::SeqCst);
    let wrong = download_one(&conn, "h2", &dir, &AtomicU64::new(0), &AtomicBool::new(false)).await;
    assert!(matches!(wrong, Err(Failure::Refused(_))));
    assert!(!dir.join(".lumina-h2.part").exists());
    assert!(!dir.join("été (3).jpg").exists());
}
