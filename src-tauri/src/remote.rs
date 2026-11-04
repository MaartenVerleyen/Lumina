// The desktop app as a client of Lumina servers (phase 3): signing in, the server's commands, its events and
// its photos, next to the libraries on this computer. The session token lives in the operating system's
// credential store and in this process, never in the page: the window asks for "server X, command Y" and
// this module adds the token.
//
// - Servers and the cache size are kept in servers.json in the app's data folder; a server's id is its host
//   name ("cachy.tailnet.ts.net").
// - Each signed-in server has one WebSocket on /api/events; every event goes to the window as
//   `remote-event` {server, event, payload}.
// - Media goes through the `lumina-remote` protocol (`/{server}/{kind}/{id}`): thumbnails and face crops from
//   a disk cache (least recently used out above the size limit), originals and videos fetched with the
//   token, Range passed on so a video can seek.
use crate::*;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};
use tauri::{Emitter, State};
use tokio_tungstenite::tungstenite;

const KEYRING_SERVICE: &str = "Lumina server";
const DEFAULT_CACHE_MB: u64 = 2048;
// Media kinds a server serves (the frontend's MediaRef kinds); thumbnails and faces are cached
const MEDIA_KINDS: &[&str] = &["thumb", "original", "preview", "face"];
const CACHED_KINDS: &[&str] = &["thumb", "face"];
// A video asks for "the rest of the file"; it gets it in pieces of this size
const MEDIA_RANGE_STEP: u64 = 8 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone)]
pub struct ServerEntry {
    pub id: String,
    pub url: String,
    pub user: String,
    #[serde(default)]
    pub role: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    #[serde(default)]
    servers: Vec<ServerEntry>,
    #[serde(default)]
    cache_limit_mb: Option<u64>,
}

// What the window gets for each server
#[derive(Serialize)]
pub struct ServerInfo {
    id: String,
    url: String,
    // Short name for menus: the first part of the host name ("cachy")
    label: String,
    user: String,
    role: String,
    signed_in: bool,
}

pub struct Remote {
    pub http: reqwest::Client,
    dir: PathBuf,
    settings: Mutex<Settings>,
    tokens: Mutex<HashMap<String, String>>,
    sockets: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
    cache_writes: AtomicUsize,
}

pub fn remote(app: &AppHandle) -> Arc<Remote> {
    app.state::<Arc<Remote>>().inner().clone()
}

// "cachy" for cachy.tailnet.ts.net; an address (192.168.1.5:8080) stays whole
fn label_of(id: &str) -> String {
    let host = id.rsplit_once(':').filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit())).map(|(h, _)| h).unwrap_or(id);
    if host.parse::<std::net::IpAddr>().is_ok() || host.starts_with('[') {
        return id.to_string();
    }
    host.split('.').next().unwrap_or(host).to_string()
}

// "cachy.tailnet.ts.net" or "https://cachy.tailnet.ts.net/" → ("https://cachy.tailnet.ts.net", id)
pub fn normalize_url(input: &str) -> Result<(String, String), String> {
    let input = input.trim().trim_end_matches('/');
    if input.is_empty() {
        return Err("Enter the server's address".into());
    }
    let url = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let parsed = reqwest::Url::parse(&url).map_err(|_| format!("\"{input}\" isn't a web address"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The address must start with https://".into());
    }
    let host = parsed.host_str().ok_or_else(|| format!("\"{input}\" has no host name"))?.to_lowercase();
    let id = match parsed.port() {
        Some(p) => format!("{host}:{p}"),
        None => host,
    };
    let base = format!("{}://{}", parsed.scheme(), id);
    Ok((base, id))
}

// Only plain names in a URL path: a command or media id can't change the route
fn plain(segment: &str) -> bool {
    !segment.is_empty() && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') && segment != ".." && segment != "."
}

// The error text of a failed answer: the server's {"error": "..."}, or the status
pub async fn error_text(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_string))
        .unwrap_or_else(|| format!("The server answered {status}"))
}

pub fn unreachable(e: reqwest::Error) -> String {
    format!("Can't reach the server ({e})")
}

impl Remote {
    pub fn load(dir: PathBuf) -> Remote {
        let settings: Settings = fs::read(dir.join("servers.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let mut tokens = HashMap::new();
        for s in &settings.servers {
            if let Some(t) = keyring_entry(s).and_then(|e| e.get_password().ok()) {
                tokens.insert(s.id.clone(), t);
            }
        }
        Remote {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .user_agent(format!("Lumina desktop {} ({})", env!("CARGO_PKG_VERSION"), std::env::consts::OS))
                .build()
                .unwrap_or_default(),
            dir,
            settings: Mutex::new(settings),
            tokens: Mutex::new(tokens),
            sockets: Mutex::new(HashMap::new()),
            cache_writes: AtomicUsize::new(0),
        }
    }

    fn save(&self) -> Result<(), String> {
        let settings = self.settings.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(&*settings).map_err(|e| e.to_string())?;
        let tmp = self.dir.join("servers.json.tmp");
        fs::write(&tmp, bytes).map_err(|e| format!("Couldn't save the server list: {e}"))?;
        fs::rename(&tmp, self.dir.join("servers.json")).map_err(|e| format!("Couldn't save the server list: {e}"))
    }

    pub fn server(&self, id: &str) -> Result<ServerEntry, String> {
        self.settings.lock().unwrap().servers.iter().find(|s| s.id == id).cloned().ok_or_else(|| format!("Lumina doesn't know the server {id}"))
    }

    pub fn token(&self, id: &str) -> Option<String> {
        self.tokens.lock().unwrap().get(id).cloned()
    }

    pub fn signed_in_ids(&self) -> Vec<String> {
        self.tokens.lock().unwrap().keys().cloned().collect()
    }

    // A request to the server with the session token; Err when signed out
    pub fn request(&self, id: &str, method: reqwest::Method, path: &str) -> Result<reqwest::RequestBuilder, String> {
        let server = self.server(id)?;
        let token = self.token(id).ok_or_else(|| format!("Signed out of {}: sign in again in Settings → Servers", label_of(id)))?;
        Ok(self.http.request(method, format!("{}{}", server.url, path)).bearer_auth(token).header("X-Lumina", "1"))
    }

    fn cache_root(&self) -> PathBuf {
        self.dir.join("remote-cache")
    }

    fn cache_limit(&self) -> u64 {
        self.settings.lock().unwrap().cache_limit_mb.unwrap_or(DEFAULT_CACHE_MB) * 1024 * 1024
    }
}

fn keyring_entry(server: &ServerEntry) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{}@{}", server.user, server.id)).ok()
}

// The server ended the session (password changed, removed, signed out elsewhere): forget the token and tell
// the window
pub fn signed_out(app: &AppHandle, id: &str) {
    let r = remote(app);
    if r.tokens.lock().unwrap().remove(id).is_none() {
        return;
    }
    if let Ok(s) = r.server(id) {
        if let Some(e) = keyring_entry(&s) {
            let _ = e.delete_credential();
        }
    }
    if let Some(h) = r.sockets.lock().unwrap().remove(id) {
        h.abort();
    }
    let _ = app.emit("remote-signed-out", json!({ "server": id }));
}

// A failed answer as the command's error; 401 also signs the window out of that server
pub async fn check(app: &AppHandle, id: &str, resp: reqwest::Response) -> Result<reqwest::Response, String> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        signed_out(app, id);
        return Err(format!("Signed out of {}: sign in again in Settings → Servers", label_of(id)));
    }
    Err(error_text(resp).await)
}

fn info(r: &Remote, s: &ServerEntry) -> ServerInfo {
    ServerInfo {
        id: s.id.clone(),
        url: s.url.clone(),
        label: label_of(&s.id),
        user: s.user.clone(),
        role: s.role.clone(),
        signed_in: r.token(&s.id).is_some(),
    }
}

// Opens the event sockets of the servers signed in at the last run
pub fn start(app: &AppHandle) {
    let r = remote(app);
    for id in r.signed_in_ids() {
        start_socket(app, &id);
    }
}

#[tauri::command]
pub fn server_list(state: State<'_, Arc<Remote>>) -> Vec<ServerInfo> {
    let r = state.inner();
    let servers = r.settings.lock().unwrap().servers.clone();
    servers.iter().map(|s| info(r, s)).collect()
}

#[derive(Deserialize)]
struct LoggedIn {
    name: String,
    role: String,
}

#[tauri::command]
pub async fn server_login(app: AppHandle, url: String, name: String, password: String) -> Result<ServerInfo, String> {
    let r = remote(&app);
    let (base, id) = normalize_url(&url)?;
    let resp = r
        .http
        .post(format!("{base}/api/auth/login"))
        .header("X-Lumina", "1")
        .json(&json!({ "name": name.trim(), "password": password }))
        .send()
        .await
        .map_err(unreachable)?;
    if !resp.status().is_success() {
        return Err(error_text(resp).await);
    }
    // The session token comes as the browser's cookie; the app keeps it in the credential store instead
    let token = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .find_map(|c| c.split(';').next()?.trim().strip_prefix("lumina_session=").map(str::to_string))
        .ok_or("The server didn't answer with a session (is this a Lumina server?)")?;
    let user: LoggedIn = resp.json().await.map_err(|e| format!("The server's answer wasn't understood: {e}"))?;
    let entry = ServerEntry { id: id.clone(), url: base, user: user.name.clone(), role: user.role };
    {
        let mut settings = r.settings.lock().unwrap();
        // Signing in again as someone else replaces the old account's token
        if let Some(old) = settings.servers.iter().find(|s| s.id == id) {
            if old.user != entry.user {
                if let Some(e) = keyring_entry(old) {
                    let _ = e.delete_credential();
                }
            }
        }
        settings.servers.retain(|s| s.id != id);
        settings.servers.push(entry.clone());
    }
    r.save()?;
    keyring_entry(&entry)
        .ok_or("The system's credential store isn't available")?
        .set_password(&token)
        .map_err(|e| format!("Couldn't keep the session in the system's credential store: {e}"))?;
    r.tokens.lock().unwrap().insert(id.clone(), token);
    start_socket(&app, &id);
    Ok(info(&r, &entry))
}

#[tauri::command]
pub async fn server_logout(app: AppHandle, server: String) -> Result<(), String> {
    let r = remote(&app);
    if let Ok(req) = r.request(&server, reqwest::Method::POST, "/api/auth/logout") {
        // Signed out here even when the server can't be reached; its session then ends after 90 idle days
        let _ = req.timeout(Duration::from_secs(10)).send().await;
    }
    signed_out(&app, &server);
    Ok(())
}

#[tauri::command]
pub async fn server_remove(app: AppHandle, server: String) -> Result<(), String> {
    server_logout(app.clone(), server.clone()).await?;
    let r = remote(&app);
    r.settings.lock().unwrap().servers.retain(|s| s.id != server);
    r.save()?;
    let _ = fs::remove_dir_all(r.cache_root().join(safe(&server)));
    Ok(())
}

// Who this app is signed in as on the server, as the server says now (role changes included)
#[tauri::command]
pub async fn server_me(app: AppHandle, server: String) -> Result<Value, String> {
    let r = remote(&app);
    let resp = r.request(&server, reqwest::Method::GET, "/api/auth/me")?.timeout(Duration::from_secs(15)).send().await.map_err(unreachable)?;
    let me: Value = check(&app, &server, resp).await?.json().await.map_err(|e| e.to_string())?;
    if let Some(role) = me["role"].as_str() {
        let mut settings = r.settings.lock().unwrap();
        if let Some(s) = settings.servers.iter_mut().find(|s| s.id == server) {
            s.role = role.to_string();
        }
    }
    let _ = r.save();
    Ok(me)
}

// One of the engine's commands, run by the server: the same names and arguments as the local engine's
#[tauri::command]
pub async fn server_call(app: AppHandle, server: String, command: String, args: Option<Value>, client: Option<String>) -> Result<Value, String> {
    if !plain(&command) {
        return Err(format!("Not a command: {command}"));
    }
    let r = remote(&app);
    let mut req = r.request(&server, reqwest::Method::POST, &format!("/api/rpc/{command}"))?;
    // The window that made a change names itself, so it can skip the server's echo of it
    if let Some(c) = client {
        req = req.header("X-Lumina-Client", c);
    }
    // Listing a large library or a long job can take a while; nothing waits forever
    let resp = req.timeout(Duration::from_secs(600)).json(&args.unwrap_or_else(|| json!({}))).send().await.map_err(unreachable)?;
    let text = check(&app, &server, resp).await?.text().await.map_err(|e| e.to_string())?;
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("The server's answer wasn't understood: {e}"))
}

// Events: one WebSocket per signed-in server, again after a pause (1 s, 2 s, ... 30 s) when it closes.
// Ends when the server refuses the session.
fn start_socket(app: &AppHandle, id: &str) {
    let r = remote(app);
    let (app2, id2) = (app.clone(), id.to_string());
    let handle = tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_secs(1);
        let mut connected_before = false;
        loop {
            let Some(token) = remote(&app2).token(&id2) else { return };
            match listen_once(&app2, &id2, &token, &mut connected_before).await {
                Ok(()) => delay = Duration::from_secs(1),
                Err(SocketEnd::SignedOut) => {
                    signed_out(&app2, &id2);
                    return;
                }
                Err(SocketEnd::Failed) => {}
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    });
    if let Some(old) = r.sockets.lock().unwrap().insert(id.to_string(), handle) {
        old.abort();
    }
}

enum SocketEnd {
    SignedOut,
    Failed,
}

async fn listen_once(app: &AppHandle, id: &str, token: &str, connected_before: &mut bool) -> Result<(), SocketEnd> {
    use tungstenite::client::IntoClientRequest;
    let server = remote(app).server(id).map_err(|_| SocketEnd::SignedOut)?;
    let ws_url = format!("{}/api/events", server.url.replacen("http", "ws", 1));
    let mut req = ws_url.into_client_request().map_err(|_| SocketEnd::Failed)?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse().map_err(|_| SocketEnd::Failed)?);
    let (mut ws, _) = match tokio_tungstenite::connect_async(req).await {
        Ok(ok) => ok,
        Err(tungstenite::Error::Http(resp)) if resp.status() == 401 => return Err(SocketEnd::SignedOut),
        Err(_) => return Err(SocketEnd::Failed),
    };
    let _ = app.emit("remote-connected", json!({ "server": id }));
    // Events from while the socket was down are lost: the window fetches what it shows again (RECONNECTED in
    // src/api/remote.ts)
    if *connected_before {
        let _ = app.emit("remote-event", json!({ "server": id, "event": "events-reconnected", "payload": null }));
    }
    *connected_before = true;
    while let Some(msg) = ws.next().await {
        match msg {
            Ok(tungstenite::Message::Text(text)) => {
                let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                let Some(event) = v["event"].as_str() else { continue };
                let _ = app.emit("remote-event", json!({ "server": id, "event": event, "payload": v["payload"] }));
            }
            Ok(tungstenite::Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
    // The server closes the socket of an ended session; the next connection finds out with a 401
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses_and_names() {
        assert_eq!(normalize_url("cachy.tail.ts.net/").unwrap(), ("https://cachy.tail.ts.net".into(), "cachy.tail.ts.net".into()));
        assert_eq!(normalize_url("http://127.0.0.1:8090").unwrap(), ("http://127.0.0.1:8090".into(), "127.0.0.1:8090".into()));
        assert!(normalize_url("ftp://x").is_err());
        assert_eq!(label_of("cachy.tail.ts.net"), "cachy");
        assert_eq!(label_of("127.0.0.1:8090"), "127.0.0.1:8090");
        assert_eq!(bounded_range("bytes=0-"), "bytes=0-8388607");
        assert_eq!(bounded_range("bytes=10-20"), "bytes=10-20");
        assert_eq!(bounded_range("bytes=-500"), "bytes=-500");
        assert_eq!(percent_decode("a%2Fthumb%2Fb%3A1"), "a/thumb/b:1");
        assert!(!plain("..") && !plain("a/b") && plain("abc_12-3.x"));
    }
}

// Media: lumina-remote://localhost/<server>%2F<kind>%2F<id> (http://lumina-remote.localhost/... on Windows)

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(b) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// A file name made of an id: anything but letters, digits, '.', '_' and '-' becomes '_'
pub fn safe(id: &str) -> String {
    id.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' }).collect()
}

fn sniff(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "application/octet-stream"
    }
}

type MediaResponse = tauri::http::Response<Vec<u8>>;

fn media_status(status: u16) -> MediaResponse {
    tauri::http::Response::builder().status(status).header("Access-Control-Allow-Origin", "*").body(Vec::new()).unwrap()
}

// "bytes=a-" or "bytes=a-b" is cut to at most MEDIA_RANGE_STEP; anything else goes as it is
fn bounded_range(range: &str) -> String {
    let Some(spec) = range.strip_prefix("bytes=") else { return range.to_string() };
    let Some((a, b)) = spec.split_once('-') else { return range.to_string() };
    let Ok(start) = a.trim().parse::<u64>() else { return range.to_string() };
    let last = start + MEDIA_RANGE_STEP - 1;
    match b.trim().parse::<u64>() {
        Ok(end) if end <= last => range.to_string(),
        _ => format!("bytes={start}-{last}"),
    }
}

pub async fn serve_media(app: AppHandle, request: tauri::http::Request<Vec<u8>>) -> MediaResponse {
    let decoded = percent_decode(request.uri().path().trim_start_matches('/'));
    let mut parts = decoded.splitn(3, '/');
    let (Some(server), Some(kind), Some(id)) = (parts.next(), parts.next(), parts.next()) else { return media_status(400) };
    if !MEDIA_KINDS.contains(&kind) || !plain(id) {
        return media_status(400);
    }
    let r = remote(&app);
    let cached = CACHED_KINDS.contains(&kind);
    let cache_file = r.cache_root().join(safe(server)).join(kind).join(safe(id));
    if cached {
        if let Ok(bytes) = fs::read(&cache_file) {
            // Recently used: the cache trims the files used longest ago first
            if let Ok(f) = fs::OpenOptions::new().write(true).open(&cache_file) {
                let _ = f.set_modified(SystemTime::now());
            }
            return tauri::http::Response::builder()
                .header("Content-Type", sniff(&bytes))
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap();
        }
    }
    let Ok(mut req) = r.request(server, reqwest::Method::GET, &format!("/media/{kind}/{id}")) else { return media_status(401) };
    if let Some(range) = request.headers().get("range").and_then(|v| v.to_str().ok()) {
        req = req.header("Range", bounded_range(range));
    }
    let resp = match req.timeout(Duration::from_secs(300)).send().await {
        Ok(resp) => resp,
        Err(_) => return media_status(502),
    };
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        signed_out(&app, server);
    }
    let mut builder = tauri::http::Response::builder()
        .status(status.as_u16())
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges");
    for name in ["content-type", "content-range", "accept-ranges"] {
        if let Some(v) = resp.headers().get(name).and_then(|v| v.to_str().ok()) {
            builder = builder.header(name, v);
        }
    }
    let Ok(bytes) = resp.bytes().await else { return media_status(502) };
    let bytes = bytes.to_vec();
    if cached && status == reqwest::StatusCode::OK && !bytes.is_empty() {
        if let Some(dir) = cache_file.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if fs::write(&cache_file, &bytes).is_ok() && r.cache_writes.fetch_add(1, Ordering::Relaxed) % 200 == 0 {
            let (root, limit) = (r.cache_root(), r.cache_limit());
            std::thread::spawn(move || trim_cache(&root, limit));
        }
    }
    builder.body(bytes).unwrap()
}

fn cache_files(root: &Path) -> Vec<(PathBuf, u64, SystemTime)> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            Some((e.into_path(), m.len(), m.modified().unwrap_or(SystemTime::UNIX_EPOCH)))
        })
        .collect()
}

// Above the limit, the files used longest ago go until the cache is at 90 % of it
pub fn trim_cache(root: &Path, limit: u64) {
    let mut files = cache_files(root);
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    if total <= limit {
        return;
    }
    files.sort_by_key(|f| f.2);
    for (path, len, _) in files {
        if total <= limit / 10 * 9 {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total -= len;
        }
    }
}

#[derive(Serialize)]
pub struct CacheInfo {
    bytes: u64,
    limit_mb: u64,
}

#[tauri::command]
pub fn remote_cache_info(state: State<'_, Arc<Remote>>) -> CacheInfo {
    let r = state.inner();
    CacheInfo { bytes: cache_files(&r.cache_root()).iter().map(|f| f.1).sum(), limit_mb: r.cache_limit() / 1024 / 1024 }
}

#[tauri::command]
pub fn set_remote_cache_limit(state: State<'_, Arc<Remote>>, limit_mb: u64) -> Result<(), String> {
    let r = state.inner();
    r.settings.lock().unwrap().cache_limit_mb = Some(limit_mb.clamp(100, 1024 * 1024));
    r.save()?;
    let (root, limit) = (r.cache_root(), r.cache_limit());
    std::thread::spawn(move || trim_cache(&root, limit));
    Ok(())
}

#[tauri::command]
pub fn clear_remote_cache(state: State<'_, Arc<Remote>>) -> Result<(), String> {
    let root = state.inner().cache_root();
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("Couldn't empty the cache: {e}"))?;
    }
    Ok(())
}
