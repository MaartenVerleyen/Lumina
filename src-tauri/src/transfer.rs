// Moving files to and from a server, without the app around it (the queues in uploads.rs and downloads.rs
// add persistence, retries and progress; the tests run this against a stand-in server).
//
// Upload: `check` which files the server lacks (Lumina's content hash), then per file `POST /api/upload`
// (which resumes an upload the server already started), 8 MB chunks with `PUT /api/upload/{id}` at the
// offset the server expects, and `finish`, where the server checks the whole file's BLAKE3.
// Download: `GET /media/download/{hash}` into a part file, resumed with Range, checked against the BLAKE3
// the server sends, then given the original's name (" (2)" when it exists).
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

pub const CHUNK: u64 = 8 * 1024 * 1024;

pub struct Conn {
    pub http: reqwest::Client,
    pub base: String,
    pub token: String,
}

// Why a transfer stopped. A network failure is tried again later; the others are final for this file.
#[derive(Debug, PartialEq)]
pub enum Failure {
    Network(String),
    SignedOut,
    Refused(String),
    Cancelled,
}

fn net(e: reqwest::Error) -> Failure {
    Failure::Network(e.to_string())
}

impl Conn {
    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, format!("{}{}", self.base, path)).bearer_auth(&self.token).header("X-Lumina", "1")
    }
}

async fn refused(resp: reqwest::Response) -> Failure {
    match resp.status().as_u16() {
        401 => Failure::SignedOut,
        // A proxy or the server itself having a moment: try again later
        429 | 502 | 503 | 504 => Failure::Network(format!("the server answered {}", resp.status())),
        _ => Failure::Refused(crate::remote::error_text(resp).await),
    }
}

// Lumina's content hash (as the server indexes the file) and the whole file's BLAKE3
pub fn hash_file(path: &Path) -> Result<(String, String, u64), String> {
    let size = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let (hash, _) = lumina_core::imaging::hash_and_read_head(path, size)?;
    Ok((hash, file_blake3(path)?, size))
}

pub fn file_blake3(path: &Path) -> Result<String, String> {
    let mut hasher = blake3::Hasher::new();
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    std::io::copy(&mut file, &mut hasher).map_err(|e| e.to_string())?;
    Ok(hasher.finalize().to_hex().to_string())
}

// Of these (hash, size), the hashes the server doesn't have
pub async fn check_missing(conn: &Conn, files: &[(String, u64, String)]) -> Result<Vec<String>, Failure> {
    let files: Vec<Value> = files.iter().map(|(hash, size, name)| json!({ "hash": hash, "size": size, "name": name })).collect();
    let resp = conn.req(reqwest::Method::POST, "/api/upload/check").timeout(Duration::from_secs(120)).json(&json!({ "files": files })).send().await.map_err(net)?;
    if !resp.status().is_success() {
        return Err(refused(resp).await);
    }
    let body: Value = resp.json().await.map_err(net)?;
    Ok(body["missing"].as_array().map(|a| a.iter().filter_map(|h| h.as_str().map(str::to_string)).collect()).unwrap_or_default())
}

pub struct UploadFile<'a> {
    pub path: &'a Path,
    pub name: &'a str,
    pub size: u64,
    pub hash: &'a str,
    pub full_hash: &'a str,
    // Seconds since 1970
    pub modified: i64,
}

fn read_chunk(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

// Sends one file; `sent` follows the bytes the server has. Answers the server's PhotoItem (null for a
// sidecar).
pub async fn upload_one(conn: &Conn, file: &UploadFile<'_>, sent: &AtomicU64, cancel: &AtomicBool, client: &str) -> Result<Value, Failure> {
    let resp = conn
        .req(reqwest::Method::POST, "/api/upload")
        .timeout(Duration::from_secs(60))
        .json(&json!({ "name": file.name, "size": file.size, "hash": file.hash, "full_hash": file.full_hash, "modified": file.modified }))
        .send()
        .await
        .map_err(net)?;
    if !resp.status().is_success() {
        return Err(refused(resp).await);
    }
    let started: Value = resp.json().await.map_err(net)?;
    let id = started["id"].as_str().ok_or_else(|| Failure::Refused("The server didn't start the upload".into()))?.to_string();
    let mut offset = started["received"].as_u64().unwrap_or(0);
    sent.store(offset, Ordering::Relaxed);
    while offset < file.size {
        if cancel.load(Ordering::Relaxed) {
            return Err(Failure::Cancelled);
        }
        let len = CHUNK.min(file.size - offset);
        let path = file.path.to_path_buf();
        let bytes = tokio::task::spawn_blocking(move || read_chunk(&path, offset, len))
            .await
            .map_err(|e| Failure::Refused(e.to_string()))?
            .map_err(|e| Failure::Refused(format!("Couldn't read the file: {e}")))?;
        if bytes.len() as u64 != len {
            return Err(Failure::Refused("The file changed while it was being sent".into()));
        }
        let resp = conn
            .req(reqwest::Method::PUT, &format!("/api/upload/{id}"))
            .header("Upload-Offset", offset.to_string())
            .header("Content-Type", "application/octet-stream")
            .timeout(Duration::from_secs(300))
            .body(bytes)
            .send()
            .await
            .map_err(net)?;
        if resp.status() == reqwest::StatusCode::CONFLICT {
            // Not where the server stands (a chunk got there but its answer didn't): carry on from there
            let body: Value = resp.json().await.map_err(net)?;
            offset = body["offset"].as_u64().ok_or_else(|| Failure::Refused("The server lost track of the upload".into()))?;
        } else if resp.status().is_success() {
            let body: Value = resp.json().await.map_err(net)?;
            offset = body["received"].as_u64().unwrap_or(offset + len);
        } else {
            return Err(refused(resp).await);
        }
        sent.store(offset, Ordering::Relaxed);
    }
    let resp = conn
        .req(reqwest::Method::POST, &format!("/api/upload/{id}/finish"))
        .header("X-Lumina-Client", client)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(net)?;
    if !resp.status().is_success() {
        return Err(refused(resp).await);
    }
    resp.json().await.map_err(net)
}

// filename*=UTF-8''... (exact), else filename="..."
pub fn disposition_name(header: &str) -> Option<String> {
    let mut plain = None;
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename*=") {
            let v = v.strip_prefix("UTF-8''").or_else(|| v.strip_prefix("utf-8''")).unwrap_or(v);
            let mut out = Vec::new();
            let b = v.as_bytes();
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'%' && i + 2 < b.len() {
                    if let Some(x) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                        out.push(x);
                        i += 3;
                        continue;
                    }
                }
                out.push(b[i]);
                i += 1;
            }
            if let Ok(s) = String::from_utf8(out) {
                return Some(s);
            }
        } else if let Some(v) = part.strip_prefix("filename=") {
            plain = Some(v.trim_matches('"').to_string());
        }
    }
    plain
}

// Only a file's own name, and no name that means something else to the file system
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base.chars().map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." { "photo".to_string() } else { cleaned }
}

// "name.jpg", or "name (2).jpg", "name (3).jpg", ... when it exists
pub fn free_name(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (name.to_string(), String::new()),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

// Downloads one original into `dir`; answers the saved file and its size. The part file
// (.lumina-<hash>.part) stays after a failure, and the next try carries on from its end.
pub async fn download_one(conn: &Conn, hash: &str, dir: &Path, received: &AtomicU64, cancel: &AtomicBool) -> Result<(PathBuf, u64), Failure> {
    fs::create_dir_all(dir).map_err(|e| Failure::Refused(format!("Couldn't make the folder: {e}")))?;
    let part = dir.join(format!(".lumina-{hash}.part"));
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    let mut req = conn.req(reqwest::Method::GET, &format!("/media/download/{hash}")).timeout(Duration::from_secs(3600));
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let mut resp = req.send().await.map_err(net)?;
    if resp.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // The part file is already whole (or longer than the original): start again
        let _ = fs::remove_file(&part);
        return Err(Failure::Network("starting the download again".into()));
    }
    if !resp.status().is_success() {
        return Err(refused(resp).await);
    }
    let resumed = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let header = |name: &str| resp.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let name = header("content-disposition").and_then(|d| disposition_name(&d)).map(|n| safe_file_name(&n)).unwrap_or_else(|| format!("{hash}.jpg"));
    let expected = header("x-lumina-blake3");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(resumed)
        .write(true)
        .truncate(!resumed)
        .open(&part)
        .map_err(|e| Failure::Refused(format!("Couldn't write in the folder: {e}")))?;
    let mut done = if resumed { have } else { 0 };
    received.store(done, Ordering::Relaxed);
    while let Some(chunk) = resp.chunk().await.map_err(net)? {
        if cancel.load(Ordering::Relaxed) {
            return Err(Failure::Cancelled);
        }
        file.write_all(&chunk).map_err(|e| Failure::Refused(format!("Couldn't write the file: {e}")))?;
        done += chunk.len() as u64;
        received.store(done, Ordering::Relaxed);
    }
    file.flush().map_err(|e| Failure::Refused(e.to_string()))?;
    drop(file);
    let part2 = part.clone();
    let actual = tokio::task::spawn_blocking(move || file_blake3(&part2)).await.map_err(|e| Failure::Refused(e.to_string()))?.map_err(Failure::Refused)?;
    if let Some(expected) = expected {
        if !expected.eq_ignore_ascii_case(&actual) {
            let _ = fs::remove_file(&part);
            return Err(Failure::Refused("The file didn't arrive intact (its BLAKE3 differs); download it again".into()));
        }
    }
    let dest = free_name(dir, &name);
    fs::rename(&part, &dest).map_err(|e| Failure::Refused(format!("Couldn't name the file: {e}")))?;
    Ok((dest, done))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_content_disposition() {
        assert_eq!(disposition_name("attachment; filename=\"a b.jpg\"; filename*=UTF-8''a%20b.jpg").as_deref(), Some("a b.jpg"));
        assert_eq!(disposition_name("attachment; filename=\"_t.jpg\"; filename*=UTF-8''%C3%A9t%C3%A9.jpg").as_deref(), Some("été.jpg"));
        assert_eq!(disposition_name("attachment; filename=\"x.jpg\"").as_deref(), Some("x.jpg"));
        assert_eq!(safe_file_name("../../evil.jpg"), "evil.jpg");
        assert_eq!(safe_file_name("C:\\x\\con:.jpg"), "con_.jpg");
        assert_eq!(safe_file_name(".."), "photo");
    }

    #[test]
    fn a_name_that_exists_gets_a_number() {
        let dir = std::env::temp_dir().join(format!("lumina-free-name-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(free_name(&dir, "a.jpg"), dir.join("a.jpg"));
        fs::write(dir.join("a.jpg"), b"1").unwrap();
        assert_eq!(free_name(&dir, "a.jpg"), dir.join("a (2).jpg"));
        fs::write(dir.join("a (2).jpg"), b"1").unwrap();
        assert_eq!(free_name(&dir, "a.jpg"), dir.join("a (3).jpg"));
        assert_eq!(free_name(&dir, "noext"), dir.join("noext"));
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod protocol_tests;
