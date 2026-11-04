// The HTTP routes against a temporary data folder, with tower's oneshot (no network)
use super::*;
use crate::accounts::Role;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, Request as HttpRequest};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

struct TestServer {
    app: Router,
    dir: PathBuf,
    host: Arc<ServerHost>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// A server on its own data folder, with a viewer, an editor and an admin (password "long enough"), and a
// built web client of one file
fn server(name: &str) -> TestServer {
    let dir = std::env::temp_dir().join(format!("lumina_http_test_{name}_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let web = dir.join("web");
    std::fs::create_dir_all(&web).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html><title>Lumina</title>").unwrap();
    let host = Arc::new(ServerHost::new(dir.clone()));
    let conn = db::open_global_db(&*host).unwrap();
    // The engine migrates once per process; every test has a database of its own
    db::migrate(&conn).unwrap();
    accounts::ensure_tables(&conn).unwrap();
    for (name, role) in [("vera", Role::Viewer), ("ed", Role::Editor), ("ada", Role::Admin)] {
        accounts::create_user(&conn, name, role, "long enough").unwrap();
    }
    let state = Arc::new(AppState { host: host.clone(), web_dir: Some(web), throttle: Default::default(), upload_library: None });
    let app = router(state).layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50000))));
    TestServer { app, dir, host }
}

async fn send(app: &Router, req: HttpRequest<Body>) -> (StatusCode, HeaderMap, Value) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, headers, body)
}

fn post(path: &str, body: Value, cookie: Option<&str>) -> HttpRequest<Body> {
    let mut req = HttpRequest::post(path).header(header::CONTENT_TYPE, "application/json").header("x-lumina", "1");
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    req.body(Body::from(body.to_string())).unwrap()
}

fn get(path: &str, cookie: Option<&str>) -> HttpRequest<Body> {
    let mut req = HttpRequest::get(path);
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, c);
    }
    req.body(Body::empty()).unwrap()
}

// Logs in and returns the "lumina_session=..." pair for the Cookie header
async fn login(app: &Router, name: &str) -> String {
    let (status, headers, _) = send(app, post("/api/auth/login", json!({"name": name, "password": "long enough"}), None)).await;
    assert_eq!(status, StatusCode::OK);
    let set_cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    set_cookie.split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn login_sets_a_strict_http_only_cookie_and_me_answers() {
    let s = server("login");
    let (status, headers, body) =
        send(&s.app, post("/api/auth/login", json!({"name": "ED", "password": "long enough"}), None)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"name": "ed", "role": "editor"}));
    let cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    for part in ["lumina_session=", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age="] {
        assert!(cookie.contains(part), "{part} missing in {cookie}");
    }
    let session = cookie.split(';').next().unwrap();
    let (status, _, body) = send(&s.app, get("/api/auth/me", Some(session))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"name": "ed", "role": "editor"}));
}

#[tokio::test]
async fn a_wrong_password_and_an_unknown_name_answer_the_same() {
    let s = server("wrong");
    let wrong = send(&s.app, post("/api/auth/login", json!({"name": "ed", "password": "not the one"}), None)).await;
    // Past the address's wait from the first failure
    tokio::time::sleep(std::time::Duration::from_millis(550)).await;
    let unknown = send(&s.app, post("/api/auth/login", json!({"name": "nobody", "password": "long enough"}), None)).await;
    assert_eq!(wrong.0, StatusCode::UNAUTHORIZED);
    assert_eq!((wrong.0, &wrong.2), (unknown.0, &unknown.2));
    assert!(wrong.1.get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn failed_logins_hold_back_the_next_try_with_429() {
    let s = server("slow");
    send(&s.app, post("/api/auth/login", json!({"name": "ed", "password": "not the one"}), None)).await;
    let (status, headers, body) = send(&s.app, post("/api/auth/login", json!({"name": "ed", "password": "long enough"}), None)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "even the right password waits its turn");
    assert_eq!(headers.get(header::RETRY_AFTER).unwrap(), "1");
    assert!(body["error"].as_str().unwrap().starts_with("Too many attempts"));
    tokio::time::sleep(std::time::Duration::from_millis(550)).await;
    let (status, _, _) = send(&s.app, post("/api/auth/login", json!({"name": "ed", "password": "long enough"}), None)).await;
    assert_eq!(status, StatusCode::OK, "after the wait it works");
}

// Attempts sent at once must not all be checked: one per key gets its password checked, the rest 429
#[tokio::test]
async fn parallel_wrong_attempts_check_one_password_per_key() {
    let s = server("parallel");
    let attempts = (0..20).map(|i| {
        let app = s.app.clone();
        tokio::spawn(async move {
            send(&app, post("/api/auth/login", json!({"name": "ed", "password": format!("guess {i}")}), None)).await.0
        })
    });
    let statuses: Vec<StatusCode> = futures_join(attempts).await;
    let checked = statuses.iter().filter(|s| **s == StatusCode::UNAUTHORIZED).count();
    let refused = statuses.iter().filter(|s| **s == StatusCode::TOO_MANY_REQUESTS).count();
    assert_eq!((checked, refused), (1, 19), "{statuses:?}");

    // After the wait, again only one of a parallel burst is checked, and the wait has doubled
    tokio::time::sleep(std::time::Duration::from_millis(550)).await;
    let burst = (0..20).map(|_| {
        let app = s.app.clone();
        tokio::spawn(async move { send(&app, post("/api/auth/login", json!({"name": "ed", "password": "nope"}), None)).await })
    });
    let answers: Vec<(StatusCode, HeaderMap, Value)> = futures_join(burst).await;
    assert_eq!(answers.iter().filter(|a| a.0 == StatusCode::UNAUTHORIZED).count(), 1);
    let retry = answers.iter().find(|a| a.0 == StatusCode::TOO_MANY_REQUESTS).unwrap().1.get(header::RETRY_AFTER).unwrap().clone();
    assert!(retry == "1" || retry == "2", "{retry:?}");
}

async fn futures_join<T: Send + 'static>(tasks: impl Iterator<Item = tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut out = Vec::new();
    for t in tasks.collect::<Vec<_>>() {
        out.push(t.await.unwrap());
    }
    out
}

#[tokio::test]
async fn no_session_means_401_for_api_and_media() {
    let s = server("nosession");
    for req in [
        get("/api/auth/me", None),
        post("/api/rpc/get_albums", json!({}), None),
        get("/api/anything", None),
        get("/media/thumb/abc", None),
        get("/api/auth/me", Some("lumina_session=0000000000000000000000000000000000000000000000000000000000000000")),
    ] {
        let path = req.uri().path().to_string();
        let (status, _, body) = send(&s.app, req).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{path}");
        assert_eq!(body, json!({"error": "Not logged in"}), "{path}");
    }
}

#[tokio::test]
async fn a_viewer_cant_call_an_editor_command() {
    let s = server("roles");
    let viewer = login(&s.app, "vera").await;
    let (status, _, body) = send(&s.app, post("/api/rpc/create_album", json!({"name": "Trip"}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body, json!({"error": "create_album needs the editor role"}));
    let (status, _, albums) = send(&s.app, post("/api/rpc/get_albums", json!({}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(albums, json!([]));

    let editor = login(&s.app, "ed").await;
    let (status, _, id) = send(&s.app, post("/api/rpc/create_album", json!({"name": "Trip"}), Some(&editor))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(id.is_i64());
    let (_, _, albums) = send(&s.app, post("/api/rpc/get_albums", json!({}), Some(&viewer))).await;
    assert_eq!(albums[0]["name"], "Trip");
}

#[tokio::test]
async fn rpc_answers_404_for_unknown_commands_and_400_for_bad_arguments() {
    let s = server("rpc");
    let admin = login(&s.app, "ada").await;
    let (status, _, body) = send(&s.app, post("/api/rpc/open_in_default_app", json!({"path": "/"}), Some(&admin))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "open_in_default_app isn't available on the server"}));
    let (status, _, body) = send(&s.app, post("/api/rpc/no_such_command", json!({}), Some(&admin))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "Unknown command: no_such_command"}));
    let (status, _, body) = send(&s.app, post("/api/rpc/create_album", json!({"title": "x"}), Some(&admin))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("name"), "{body}");
    // camelCase arguments, as the frontend sends them to Tauri
    let (status, _, _) =
        send(&s.app, post("/api/rpc/shift_capture_timestamps", json!({"hashes": [], "offsetMinutes": 60}), Some(&admin))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send(&s.app, post("/api/rpc/semantic_status", json!({"rootFolder": null}), Some(&admin))).await;
    assert_eq!(status, StatusCode::OK);
    // A folder that isn't one of the server's libraries
    let (status, _, body) =
        send(&s.app, post("/api/rpc/semantic_status", json!({"rootFolder": "/photos"}), Some(&admin))).await;
    assert_eq!((status, body), (StatusCode::NOT_FOUND, json!({"error": "Not a library on this server"})));
}

#[tokio::test]
async fn changes_need_the_x_lumina_header() {
    let s = server("csrf");
    let admin = login(&s.app, "ada").await;
    let no_header = |path: &str, body: Value| {
        HttpRequest::post(path)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &admin)
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    for (path, body) in [
        ("/api/rpc/create_album", json!({"name": "x"})),
        ("/api/auth/login", json!({"name": "ada", "password": "long enough"})),
        ("/api/auth/logout", json!({})),
    ] {
        let (status, _, body) = send(&s.app, no_header(path, body)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}");
        assert_eq!(body, json!({"error": "Missing the X-Lumina: 1 header"}));
    }
}

#[tokio::test]
async fn a_bearer_token_works_and_logout_ends_the_session() {
    let s = server("bearer");
    let cookie = login(&s.app, "ed").await;
    let token = cookie.trim_start_matches("lumina_session=").to_string();
    let bearer = HttpRequest::get("/api/auth/me").header(header::AUTHORIZATION, format!("Bearer {token}")).body(Body::empty()).unwrap();
    assert_eq!(send(&s.app, bearer).await.0, StatusCode::OK);

    let (status, headers, _) = send(&s.app, post("/api/auth/logout", json!({}), Some(&cookie))).await;
    assert_eq!(status, StatusCode::OK);
    let cleared = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(cleared.starts_with("lumina_session=;") || cleared.contains("Max-Age=0"), "{cleared}");
    assert_eq!(send(&s.app, get("/api/auth/me", Some(&cookie))).await.0, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_web_client_is_served_with_its_security_headers() {
    let s = server("web");
    for path in ["/", "/people/someone", "/index.html"] {
        let (status, headers, body) = send(&s.app, get(path, None)).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(body.as_str().unwrap().contains("<title>Lumina</title>"), "{path}: index.html for app routes");
        let csp = headers.get("content-security-policy").unwrap().to_str().unwrap();
        assert!(csp.contains("script-src 'self' 'wasm-unsafe-eval';") && csp.contains("frame-ancestors 'none'"));
        assert_eq!(headers.get("x-content-type-options").unwrap(), "nosniff");
    }
    // API answers carry them too, and an unknown API route is not the web client
    let admin = login(&s.app, "ada").await;
    let (status, headers, body) = send(&s.app, get("/api/nothing-here", Some(&admin))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, json!({"error": "Unknown API route"}));
    assert!(headers.get("content-security-policy").is_some());
}

#[test]
fn the_client_address_comes_from_x_forwarded_for_only_behind_a_local_proxy_or_docker() {
    let mut headers = HeaderMap::new();
    headers.insert("x-forwarded-for", "100.64.0.7, 127.0.0.1".parse().unwrap());
    let local = SocketAddr::from(([127, 0, 0, 1], 1));
    let docker_gateway = SocketAddr::from(([172, 21, 0, 1], 1));
    let tailnet = SocketAddr::from(([100, 71, 44, 14], 1));
    assert_eq!(client_addr(Some(local), &headers), "100.64.0.7");
    assert_eq!(client_addr(Some(docker_gateway), &headers), "100.64.0.7");
    assert_eq!(client_addr(Some(tailnet), &headers), "100.71.44.14", "a direct client can't choose its address");
    assert_eq!(client_addr(Some(local), &HeaderMap::new()), "127.0.0.1");
}

// ---- Milestone 2: libraries, media, and the frontend's commands ----

// A library with one photo (a.jpg), its thumbnail and one face crop, in the test server's database
fn add_library(s: &TestServer) -> (String, String) {
    let root = s.dir.join("Library");
    std::fs::create_dir_all(&root).unwrap();
    let photo = root.join("a.jpg");
    std::fs::write(&photo, vec![7u8; 4000]).unwrap();
    let data = s.dir.clone();
    std::fs::create_dir_all(data.join("thumbnails")).unwrap();
    std::fs::write(data.join("thumbnails").join("abc123.jpg"), b"thumbnail bytes").unwrap();
    std::fs::create_dir_all(data.join("faces")).unwrap();
    let face_file = data.join("faces").join("abc123_10_20.jpg");
    std::fs::write(&face_file, b"face bytes").unwrap();
    let host = ServerHost::new(data);
    let conn = db::open_global_db(&host).unwrap();
    let root_str = root.to_string_lossy().to_string();
    lumina_core::libraries::open(&conn, &root_str).unwrap();
    conn.execute("INSERT INTO photos (hash, current_path) VALUES ('abc123', ?1)", [photo.to_string_lossy().to_string()]).unwrap();
    conn.execute(
        "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, face_thumb, embedding) VALUES ('abc123_10_20', 'abc123', 0.1, 0.2, 0.1, 0.1, ?1, '')",
        [face_file.to_string_lossy().to_string()],
    )
    .unwrap();
    (root_str, photo.to_string_lossy().to_string())
}

#[tokio::test]
async fn media_is_served_by_id_through_the_database() {
    let s = server("media");
    add_library(&s);
    assert_eq!(send(&s.app, get("/media/thumb/abc123", None)).await.0, StatusCode::UNAUTHORIZED);
    let viewer = login(&s.app, "vera").await;

    let (status, headers, body) = send(&s.app, get("/media/thumb/abc123", Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Value::String("thumbnail bytes".into()));
    assert_eq!(headers.get(header::CONTENT_TYPE).unwrap(), "image/jpeg");
    assert_eq!(headers.get(header::CACHE_CONTROL).unwrap(), "private, max-age=3600");

    let (status, _, body) = send(&s.app, get("/media/face/abc123_10_20.jpg", Some(&viewer))).await;
    assert_eq!((status, body), (StatusCode::OK, Value::String("face bytes".into())));

    // The file itself, and part of it (videos seek this way)
    let (status, _, _) = send(&s.app, get("/media/original/abc123", Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK);
    let range = HttpRequest::get("/media/original/abc123")
        .header(header::COOKIE, &viewer)
        .header(header::RANGE, "bytes=100-199")
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = send(&s.app, range).await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(headers.get(header::CONTENT_RANGE).unwrap(), "bytes 100-199/4000");

    // Only what the database knows: no other hash, no path pieces, no playable copy that wasn't made
    for path in ["/media/thumb/nothere", "/media/thumb/..%2F..%2Fetc%2Fpasswd", "/media/original/abc123.jpg", "/media/preview/abc123", "/media/face/nothere"] {
        assert_eq!(send(&s.app, get(path, Some(&viewer))).await.0, StatusCode::NOT_FOUND, "{path}");
    }
}

#[tokio::test]
async fn libraries_are_listed_and_opened_from_the_database() {
    let s = server("libraries");
    let (root, photo) = add_library(&s);
    let viewer = login(&s.app, "vera").await;
    let (status, _, libs) = send(&s.app, post("/api/rpc/list_libraries", json!({}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(libs[0]["root"], json!(root));
    assert_eq!(libs[0]["photos"], json!(1));

    let (status, _, photos) = send(&s.app, post("/api/rpc/scan_folder", json!({"folderPath": root}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK, "{photos}");
    assert_eq!(photos[0]["hash"], "abc123");
    assert_eq!(photos[0]["path"], json!(photo));
    let elsewhere = s.dir.join("thumbnails").to_string_lossy().to_string();
    let (status, _, _) = send(&s.app, post("/api/rpc/scan_folder", json!({"folderPath": elsewhere}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "only the server's own libraries");

    // A path sent back must be the photo's own
    let (status, _, body) = send(
        &s.app,
        post("/api/rpc/ensure_high_res_preview", json!({"hash": "abc123", "sourcePath": "/etc/passwd"}), Some(&viewer)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, json!({"error": "Not the path of that photo"}));
}

// Every command the frontend calls (`call("name"` or `call<T>("name"` in src/) is on the server, or on the list
// of commands that have no place there, or on the list of commands still to come. The last list shrinks to
// nothing by the end of phase 2.
// Editor and admin commands: milestone 3 (restore_library and inspect_backup: milestone 5)
// Nothing left to come: every command the frontend calls is on the server or on the list above
const STILL_TO_COME: &[&str] = &[];

fn frontend_commands() -> std::collections::BTreeSet<String> {
    fn walk(dir: &std::path::Path, out: &mut std::collections::BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "ts" || e == "tsx") {
                let text = std::fs::read_to_string(&path).unwrap();
                let bytes = text.as_bytes();
                let mut i = 0;
                while let Some(pos) = text[i..].find("call") {
                    let start = i + pos;
                    i = start + 4;
                    if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
                        continue;
                    }
                    let mut j = i;
                    if bytes.get(j) == Some(&b'<') {
                        let mut depth = 0;
                        while j < bytes.len() {
                            match bytes[j] {
                                b'<' => depth += 1,
                                b'>' => {
                                    depth -= 1;
                                    if depth == 0 {
                                        j += 1;
                                        break;
                                    }
                                }
                                _ => {}
                            }
                            j += 1;
                        }
                    }
                    if bytes.get(j) != Some(&b'(') {
                        continue;
                    }
                    let rest = text[j + 1..].trim_start();
                    if let Some(name) = rest.strip_prefix('"').and_then(|r| r.split('"').next()) {
                        if !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
                            out.insert(name.to_string());
                        }
                    }
                }
            }
        }
    }
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../src");
    let mut out = std::collections::BTreeSet::new();
    walk(&src, &mut out);
    out
}

#[test]
fn every_command_the_frontend_calls_is_accounted_for() {
    let calls = frontend_commands();
    assert!(calls.len() > 80, "found only {} commands: is the frontend at ../../../src?", calls.len());
    let missing: Vec<&String> = calls
        .iter()
        .filter(|c| {
            super::rpc::lookup(c).is_none()
                && !super::rpc::NOT_ON_SERVER.contains(&c.as_str())
                && !STILL_TO_COME.contains(&c.as_str())
        })
        .collect();
    assert!(missing.is_empty(), "not on the server and not listed: {missing:?}");
    // And the lists name only commands that exist in the frontend or the plan
    for c in STILL_TO_COME {
        assert!(super::rpc::lookup(c).is_none(), "{c} is on the server now: take it off STILL_TO_COME");
    }
}

// ---- Milestone 3: editing by role, live updates, who did what ----

#[tokio::test]
async fn every_editing_command_is_refused_below_its_role_before_anything_runs() {
    let s = server("refused");
    let viewer = login(&s.app, "vera").await;
    let editor = login(&s.app, "ed").await;
    for cmd in super::rpc::COMMANDS.iter().filter(|c| c.role > Role::Viewer) {
        // No arguments at all: a refusal must come before the arguments are even read
        let (status, _, body) = send(&s.app, post(&format!("/api/rpc/{}", cmd.name), json!({}), Some(&viewer))).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "viewer -> {}: {body}", cmd.name);
        if cmd.role == Role::Admin {
            let (status, _, _) = send(&s.app, post(&format!("/api/rpc/{}", cmd.name), json!({}), Some(&editor))).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "editor -> {}", cmd.name);
        }
    }
}

#[tokio::test]
async fn an_edit_is_announced_recorded_and_readable_by_others() {
    let s = server("announce");
    add_library(&s);
    let editor = login(&s.app, "ed").await;
    let viewer = login(&s.app, "vera").await;
    let mut events = s.host.subscribe();

    let req = HttpRequest::post("/api/rpc/set_photos_rating")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-lumina", "1")
        .header("x-lumina-client", "window-1")
        .header(header::COOKIE, &editor)
        .body(Body::from(json!({"hashes": ["abc123"], "rating": 4}).to_string()))
        .unwrap();
    assert_eq!(send(&s.app, req).await.0, StatusCode::OK);
    let (event, payload) = events.recv().await.unwrap();
    assert_eq!(event, "photos-changed");
    assert_eq!(payload, json!({"hashes": ["abc123"], "by": "ed", "origin": "window-1"}));

    // Another user refreshes just that photo
    let (status, _, photos) = send(&s.app, post("/api/rpc/get_photos", json!({"hashes": ["abc123", "unknown"]}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(photos.as_array().unwrap().len(), 1);
    assert_eq!(photos[0]["rating"], 4);

    // A tag, then a person: people-changed too
    send(&s.app, post("/api/rpc/add_tag_batch", json!({"hashes": ["abc123"], "tag": "beach"}), Some(&editor))).await;
    send(&s.app, post("/api/rpc/add_person_to_photos", json!({"hashes": ["abc123"], "name": "Anna"}), Some(&editor))).await;
    let mut seen = Vec::new();
    while let Ok((event, _)) = events.try_recv() {
        seen.push(event);
    }
    assert_eq!(seen, ["photos-changed", "photos-changed", "people-changed"]);

    // Albums: albums-changed, and the photo it touched
    let (_, _, id) = send(&s.app, post("/api/rpc/create_album", json!({"name": "Trip"}), Some(&editor))).await;
    assert_eq!(events.recv().await.unwrap().0, "albums-changed");
    send(&s.app, post("/api/rpc/add_to_album", json!({"id": id, "hashes": ["abc123"]}), Some(&editor))).await;
    assert_eq!(events.recv().await.unwrap().0, "albums-changed", "albums first: guests' sockets look again before the photos");
    assert_eq!(events.recv().await.unwrap().0, "photos-changed");

    // Who did what, newest first
    let (status, _, history) = send(&s.app, post("/api/rpc/get_photo_history", json!({"hash": "abc123"}), Some(&viewer))).await;
    assert_eq!(status, StatusCode::OK);
    let whats: Vec<&str> = history.as_array().unwrap().iter().map(|c| c["what"].as_str().unwrap()).collect();
    assert_eq!(whats, ["add_to_album", "add_person_to_photos", "add_tag_batch", "set_photos_rating"]);
    assert!(history.as_array().unwrap().iter().all(|c| c["user"] == "ed"));

    // Reading changes nothing and announces nothing
    send(&s.app, post("/api/rpc/get_albums", json!({}), Some(&viewer))).await;
    assert!(events.try_recv().is_err());
}

// Backup: an editor's device sends its values for photos it uploaded; they go on where the server has
// none, the face found at the same place gets its name, and other windows hear of photos, people and albums
#[tokio::test]
async fn backed_up_values_go_on_the_photos_and_are_announced() {
    let s = server("backup_values");
    add_library(&s);
    {
        let conn = db::open_global_db(&*s.host).unwrap();
        conn.execute("UPDATE photos SET rating = 3, faces_engine = 'v2' WHERE hash = 'abc123'", []).unwrap();
    }
    let editor = login(&s.app, "ed").await;
    let mut events = s.host.subscribe();
    let item = json!({
        "hash": "abc123", "rating": 5, "flag": "pick", "tags": ["Beach"], "albums": ["Holiday"],
        "faces": [{"name": "Anna", "x": 0.11, "y": 0.2, "w": 0.1, "h": 0.1}]
    });
    // A photo the server doesn't have (its upload never arrived) is named in the answer, the rest goes on
    let (status, _, report) = send(&s.app, post("/api/rpc/apply_backup_values", json!({"items": [item, {"hash": "nope"}]}), Some(&editor))).await;
    assert_eq!(status, StatusCode::OK, "{report}");
    assert_eq!((report["photos"].as_u64(), report["faces_named"].as_u64()), (Some(1), Some(1)));
    assert_eq!(report["missing"], json!(["nope"]));

    let mut seen = Vec::new();
    while let Ok((event, _)) = events.try_recv() {
        seen.push(event);
    }
    assert_eq!(seen, ["albums-changed", "photos-changed", "people-changed"]);
    let (_, _, photos) = send(&s.app, post("/api/rpc/get_photos", json!({"hashes": ["abc123"]}), Some(&editor))).await;
    assert_eq!(photos[0]["rating"], 3, "the server's rating stays");
    assert_eq!(photos[0]["flag"], "pick");
    assert_eq!(photos[0]["tags"], json!(["beach"]));
    assert_eq!(photos[0]["people"], json!(["Anna"]));
}

#[tokio::test]
async fn a_rename_announces_every_photo_of_that_person() {
    let s = server("rename");
    add_library(&s);
    let editor = login(&s.app, "ed").await;
    let conn = db::open_global_db(&*s.host).unwrap();
    conn.execute("UPDATE photo_faces SET person_name = 'Ann' WHERE face_id = 'abc123_10_20'", []).unwrap();
    conn.execute("INSERT INTO photo_people (hash, person_name) VALUES ('abc123', 'Ann')", []).unwrap();
    let mut events = s.host.subscribe();
    let (status, _, _) =
        send(&s.app, post("/api/rpc/rename_person", json!({"oldName": "Ann", "newName": "Anna"}), Some(&editor))).await;
    assert_eq!(status, StatusCode::OK);
    let (event, payload) = events.recv().await.unwrap();
    assert_eq!((event.as_str(), &payload["hashes"]), ("photos-changed", &json!(["abc123"])));
    assert_eq!(events.recv().await.unwrap().0, "people-changed");
}

#[tokio::test]
async fn paths_and_folders_from_the_client_are_checked() {
    let s = server("paths");
    let (root, photo) = add_library(&s);
    let editor = login(&s.app, "ed").await;
    let admin = login(&s.app, "ada").await;
    let elsewhere = s.dir.join("thumbnails").join("abc123.jpg").to_string_lossy().to_string();
    for (cmd, args) in [
        ("detect_faces_in_photo", json!({"hash": "abc123", "imagePath": elsewhere})),
        ("ai_analyze_photo", json!({"hash": "abc123", "imagePathForAi": "/etc/passwd", "modelName": "m", "existingTags": []})),
        ("prepare_ai_image", json!({"hash": "abc123", "imagePath": elsewhere})),
    ] {
        let (status, _, body) = send(&s.app, post(&format!("/api/rpc/{cmd}"), args, Some(&editor))).await;
        assert_eq!((status, body), (StatusCode::BAD_REQUEST, json!({"error": "Not the path of that photo"})), "{cmd}");
    }
    for (cmd, args) in [
        ("commit_staged_operations", json!({"rootFolder": "/"})),
        ("empty_library_trash_to_os", json!({"rootFolder": "/tmp"})),
        ("rescan_library", json!({"folderPath": s.dir.to_string_lossy()})),
        ("start_semantic_index", json!({"rootFolder": "/home"})),
    ] {
        let (status, _, _) = send(&s.app, post(&format!("/api/rpc/{cmd}"), args, Some(&admin))).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{cmd}");
    }
    // The real ones are accepted
    let (status, _, staged) = send(&s.app, post("/api/rpc/get_staged_operations", json!({"rootFolder": root}), Some(&editor))).await;
    assert_eq!((status, staged), (StatusCode::OK, json!([])));
    let _ = photo;
}

// ---- Milestone 4: guests, shared albums, roles per library ----

// Two libraries: Anna's (a1) and Bob's (b1, b2, b2 with a face of "Bob"); an album "Holiday" with b2 and one
// "Private" with b1. Thumbnails for all three.
fn two_libraries(s: &TestServer) -> (String, String, i64) {
    let conn = db::open_global_db(&*s.host).unwrap();
    std::fs::create_dir_all(s.dir.join("thumbnails")).unwrap();
    std::fs::create_dir_all(s.dir.join("faces")).unwrap();
    let mut roots = Vec::new();
    for (lib, photos) in [("Anna", vec!["a1"]), ("Bob", vec!["b1", "b2"])] {
        let root = s.dir.join(lib);
        std::fs::create_dir_all(&root).unwrap();
        let root_str = root.to_string_lossy().to_string();
        lumina_core::libraries::open(&conn, &root_str).unwrap();
        for hash in photos {
            let file = root.join(format!("{hash}.jpg"));
            std::fs::write(&file, b"photo").unwrap();
            std::fs::write(s.dir.join("thumbnails").join(format!("{hash}.jpg")), vec![1u8; 300]).unwrap();
            conn.execute("INSERT INTO photos (hash, current_path) VALUES (?1, ?2)", [hash, &file.to_string_lossy()]).unwrap();
        }
        roots.push(root_str);
    }
    let face = s.dir.join("faces").join("b2_1_1.jpg");
    std::fs::write(&face, b"face").unwrap();
    conn.execute(
        "INSERT INTO photo_faces (face_id, hash, bbox_x, bbox_y, bbox_w, bbox_h, face_thumb, embedding, person_name) VALUES ('b2_1_1', 'b2', 0.1, 0.1, 0.1, 0.1, ?1, '', 'Bob')",
        [face.to_string_lossy().to_string()],
    )
    .unwrap();
    conn.execute_batch(
        "INSERT INTO photo_people (hash, person_name) VALUES ('b2', 'Bob'), ('b1', 'Bob'), ('b1', 'Carol'), ('a1', 'Anna');
         INSERT INTO people (name, cover_face_thumb) VALUES ('Bob', ''), ('Carol', ''), ('Anna', '');",
    )
    .unwrap();
    let holiday = lumina_core::albums::create_album(s.host.clone(), "Holiday".into()).unwrap();
    lumina_core::albums::add_to_album(s.host.clone(), holiday, vec!["b2".into()]).unwrap();
    let private = lumina_core::albums::create_album(s.host.clone(), "Private".into()).unwrap();
    lumina_core::albums::add_to_album(s.host.clone(), private, vec!["b1".into()]).unwrap();
    // gus: a guest with Holiday shared; mia: a guest by default, an editor of Anna's library, Holiday shared too
    let gus = accounts::create_user(&conn, "gus", Role::Guest, "long enough").unwrap();
    let mia = accounts::create_user(&conn, "mia", Role::Guest, "long enough").unwrap();
    let anna_id = lumina_core::libraries::list(&conn).unwrap().into_iter().find(|l| l.root == roots[0]).unwrap().id;
    crate::scope::set_library_role(&conn, mia.id, anna_id, Some(Role::Editor)).unwrap();
    for u in [gus.id, mia.id] {
        crate::scope::share_album(&conn, holiday, u, true).unwrap();
    }
    (roots[0].clone(), roots[1].clone(), holiday)
}

fn hashes_of(list: &Value) -> Vec<String> {
    list.as_array().unwrap().iter().map(|p| p["hash"].as_str().unwrap().to_string()).collect()
}

#[tokio::test]
async fn a_guest_sees_exactly_the_shared_albums_photos_everywhere() {
    let s = server("guest");
    let (anna, bob, holiday) = two_libraries(&s);
    let gus = login(&s.app, "gus").await;
    let rpc = |cmd: &str, args: Value| post(&format!("/api/rpc/{cmd}"), args, Some(&gus));

    let (_, _, libs) = send(&s.app, rpc("list_libraries", json!({}))).await;
    assert_eq!(libs.as_array().unwrap().len(), 1, "only the library with something shared: {libs}");
    assert_eq!((&libs[0]["root"], &libs[0]["photos"], &libs[0]["role"]), (&json!(bob), &json!(1), &json!("guest")));

    let (status, _, photos) = send(&s.app, rpc("scan_folder", json!({"folderPath": bob}))).await;
    assert_eq!((status, hashes_of(&photos)), (StatusCode::OK, vec!["b2".to_string()]));
    let (status, _, _) = send(&s.app, rpc("scan_folder", json!({"folderPath": anna}))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "a library with nothing shared doesn't exist for them");
    let (_, _, fresh) = send(&s.app, rpc("get_photos", json!({"hashes": ["a1", "b1", "b2"]}))).await;
    assert_eq!(hashes_of(&fresh), ["b2"]);

    // Albums: only the shared one; People: only who is on its photos, counted there
    let (_, _, albums) = send(&s.app, rpc("get_albums", json!({}))).await;
    assert_eq!(albums.as_array().unwrap().len(), 1);
    assert_eq!((&albums[0]["id"], &albums[0]["hashes"]), (&json!(holiday), &json!(["b2"])));
    let (_, _, people) = send(&s.app, rpc("get_people", json!({"rootFolder": bob}))).await;
    let names: Vec<(&str, i64)> = people.as_array().unwrap().iter().map(|p| (p["name"].as_str().unwrap(), p["photo_count"].as_i64().unwrap())).collect();
    assert_eq!(names, [("Bob", 1)], "Carol is only on a photo they can't see");
    assert!(people[0]["cover_thumb"].as_str().unwrap().ends_with("b2_1_1.jpg"));
    let (_, _, searches) = send(&s.app, rpc("get_saved_searches", json!({}))).await;
    assert_eq!(searches, json!([]));

    // Guessing a hash tells nothing: every route answers as if it didn't exist
    for hash in ["a1", "b1"] {
        for path in [format!("/media/thumb/{hash}"), format!("/media/original/{hash}")] {
            assert_eq!(send(&s.app, get(&path, Some(&gus))).await.0, StatusCode::NOT_FOUND, "{path}");
        }
        for (cmd, args) in [
            ("find_similar_photos", json!({"hash": hash})),
            ("get_photo_history", json!({"hash": hash})),
            ("existing_playable_copy", json!({"hash": hash})),
        ] {
            assert_eq!(send(&s.app, rpc(cmd, args)).await.0, StatusCode::NOT_FOUND, "{cmd} {hash}");
        }
    }
    assert_eq!(send(&s.app, get("/media/thumb/b2", Some(&gus))).await.0, StatusCode::OK);
    assert_eq!(send(&s.app, get("/media/face/b2_1_1.jpg", Some(&gus))).await.0, StatusCode::OK);

    // Looking only: no editing, not even of the shared photo
    let (status, _, _) = send(&s.app, rpc("set_photos_rating", json!({"hashes": ["b2"], "rating": 5}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_guest_gets_no_events_about_other_photos() {
    let s = server("guestevents");
    two_libraries(&s);
    let conn = db::open_global_db(&*s.host).unwrap();
    let gus = accounts::find_user(&conn, "gus").unwrap().unwrap();
    let scope = super::events::load_scope(&s.host, &gus).await.unwrap();
    let event = |hashes: Value| json!({"hashes": hashes, "by": "ed", "origin": ""});
    let pass = |name: &'static str, payload: Value| {
        let (host, scope) = (s.host.clone(), scope.clone());
        async move { super::events::for_user(&host, &scope, name, payload).await }
    };
    assert_eq!(pass("photos-changed", event(json!(["a1", "b1"]))).await, None);
    assert_eq!(pass("photos-changed", event(json!(["b1", "b2"]))).await.unwrap()["hashes"], json!(["b2"]));
    assert!(pass("albums-changed", json!({"by": "ed"})).await.is_some());
    // Progress events name other photos (files, faces): none of them
    for name in ["scan-progress", "thumb-batch-ready", "face-scan-progress", "semantic-progress", "ai-batch-progress"] {
        assert_eq!(pass(name, json!({"current_file": "/Anna/a1.jpg"})).await, None, "{name}");
    }
}

// Thumbnails, faces and captions the server makes on its own reach open windows as photos-changed: a guest
// for the shared photos only, someone who sees everything for captions (the rest came with the progress event)
#[tokio::test]
async fn the_servers_own_work_reaches_open_windows() {
    use lumina_core::host::Host;
    let s = server("ownwork");
    two_libraries(&s);
    let mut events = s.host.subscribe();
    s.host.emit_value("ai-batch-progress", json!({"done": false, "results": [{"hash": "b1"}, {"hash": "b2"}]}));
    s.host.emit_value("face-scan-progress", json!({"done": false, "batch_faces": {"a1": [], "b2": []}}));
    s.host.emit_value("thumb-batch-ready", json!({"items": [{"hash": "b2"}]}));
    s.host.emit_value("semantic-progress", json!({"done": true}));
    let mut changed = Vec::new();
    while let Ok((name, payload)) = events.try_recv() {
        if name == "photos-changed" {
            changed.push(payload);
        }
    }
    assert_eq!(changed.len(), 3);
    assert_eq!(changed[0]["hashes"], json!(["b1", "b2"]));
    assert_eq!(changed[0]["by"], "server");

    let conn = db::open_global_db(&*s.host).unwrap();
    for (name, wanted) in [("gus", [Some(json!(["b2"])), Some(json!(["b2"])), Some(json!(["b2"]))]), ("ada", [Some(json!(["b1", "b2"])), None, None])] {
        let user = accounts::find_user(&conn, name).unwrap().unwrap();
        let scope = super::events::load_scope(&s.host, &user).await.unwrap();
        for (payload, wanted) in changed.iter().zip(wanted) {
            let got = super::events::for_user(&s.host, &scope, "photos-changed", payload.clone()).await.map(|p| p["hashes"].clone());
            assert_eq!(got, wanted, "{name} after {}", payload["after"]);
        }
    }
}

#[tokio::test]
async fn roles_per_library_let_someone_edit_their_own_and_only_look_at_what_is_shared() {
    let s = server("perlibrary");
    let (anna, bob, holiday) = two_libraries(&s);
    let mia = login(&s.app, "mia").await;
    let rpc = |cmd: &str, args: Value| post(&format!("/api/rpc/{cmd}"), args, Some(&mia));

    let (_, _, libs) = send(&s.app, rpc("list_libraries", json!({}))).await;
    let roles: Vec<(&str, &str)> = libs.as_array().unwrap().iter().map(|l| (l["root"].as_str().unwrap(), l["role"].as_str().unwrap())).collect();
    assert_eq!(roles, [(anna.as_str(), "editor"), (bob.as_str(), "guest")]);
    let (_, _, photos) = send(&s.app, rpc("scan_folder", json!({"folderPath": anna}))).await;
    assert_eq!(hashes_of(&photos), ["a1"]);

    // An album that wasn't shared with them shows only the photos of their own library in it: that b2 is in
    // it too stays unknown, though Holiday shows them b2
    let mixed = lumina_core::albums::create_album(s.host.clone(), "Mixed".into()).unwrap();
    lumina_core::albums::add_to_album(s.host.clone(), mixed, vec!["a1".into(), "b2".into()]).unwrap();
    let (_, _, albums) = send(&s.app, rpc("get_albums", json!({}))).await;
    let listed: Vec<(&str, &Value)> = albums.as_array().unwrap().iter().map(|a| (a["name"].as_str().unwrap(), &a["hashes"])).collect();
    assert_eq!(listed, [("Holiday", &json!(["b2"])), ("Mixed", &json!(["a1"]))]);

    assert_eq!(send(&s.app, rpc("set_photos_rating", json!({"hashes": ["a1"], "rating": 4}))).await.0, StatusCode::OK);
    let (status, _, body) = send(&s.app, rpc("set_photos_rating", json!({"hashes": ["b2"], "rating": 4}))).await;
    assert_eq!((status, body), (StatusCode::FORBIDDEN, json!({"error": "set_photos_rating needs the editor role"})));
    assert_eq!(send(&s.app, rpc("set_photos_rating", json!({"hashes": ["b1"], "rating": 4}))).await.0, StatusCode::NOT_FOUND);
    // One photo they may not change spoils the batch
    assert_eq!(send(&s.app, rpc("add_tag_batch", json!({"hashes": ["a1", "b2"], "tag": "x"}))).await.0, StatusCode::FORBIDDEN);
    // Bob is on Bob's library too: renaming him needs the editor role there
    assert_eq!(send(&s.app, rpc("rename_person", json!({"oldName": "Bob", "newName": "Robert"}))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&s.app, rpc("rename_person", json!({"oldName": "Anna", "newName": "Anna B"}))).await.0, StatusCode::OK);
    // Sharing Holiday (Bob's photos) is for those who may edit there; a new album is theirs to make
    assert_eq!(send(&s.app, rpc("share_album", json!({"id": holiday, "userName": "gus", "shared": false}))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&s.app, rpc("create_album", json!({"name": "Mine"}))).await.0, StatusCode::OK);
    // Server work stays with admins
    assert_eq!(send(&s.app, rpc("commit_staged_operations", json!({"rootFolder": anna}))).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn sharing_an_album_gives_and_takes_its_photos() {
    let s = server("sharing");
    let (_, bob, holiday) = two_libraries(&s);
    let admin = login(&s.app, "ada").await;
    let gus = login(&s.app, "gus").await;
    let mut events = s.host.subscribe();
    let (status, _, shares) = send(&s.app, post("/api/rpc/get_album_shares", json!({"id": holiday}), Some(&admin))).await;
    assert_eq!((status, shares), (StatusCode::OK, json!(["gus", "mia"])));

    let (status, _, _) = send(&s.app, post("/api/rpc/share_album", json!({"id": holiday, "userName": "gus", "shared": false}), Some(&admin))).await;
    assert_eq!(status, StatusCode::OK);
    let (event, payload) = events.recv().await.unwrap();
    assert_eq!(event, "albums-changed");
    let (event, payload2) = events.recv().await.unwrap();
    assert_eq!((event.as_str(), &payload2["users"]), ("shares-changed", &json!(["gus"])));
    let _ = payload;
    let (status, _, _) = send(&s.app, post("/api/rpc/scan_folder", json!({"folderPath": bob}), Some(&gus))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "nothing shared any more");
    assert_eq!(send(&s.app, get("/media/thumb/b2", Some(&gus))).await.0, StatusCode::NOT_FOUND);

    send(&s.app, post("/api/rpc/share_album", json!({"id": holiday, "userName": "gus", "shared": true}), Some(&admin))).await;
    let (_, _, photos) = send(&s.app, post("/api/rpc/scan_folder", json!({"folderPath": bob}), Some(&gus))).await;
    assert_eq!(hashes_of(&photos), ["b2"]);
    let (status, _, _) = send(&s.app, post("/api/rpc/share_album", json!({"id": holiday, "userName": "nobody", "shared": true}), Some(&admin))).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_shared_dynamic_album_shows_its_photos_and_never_its_query() {
    let s = server("dynamic");
    let (_, bob, _) = two_libraries(&s);
    {
        let conn = db::open_global_db(&*s.host).unwrap();
        accounts::create_user(&conn, "gil", Role::Guest, "long enough").unwrap();
    }
    let ed = login(&s.app, "ed").await;
    let gil = login(&s.app, "gil").await;
    let as_ed = |cmd: &str, args: Value| post(&format!("/api/rpc/{cmd}"), args, Some(&ed));
    let as_gil = |cmd: &str, args: Value| post(&format!("/api/rpc/{cmd}"), args, Some(&gil));

    let (status, _, id) = send(&s.app, as_ed("save_search", json!({"name": "Bob's photos", "query": "person:bob", "smart": false}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, _) = send(&s.app, as_ed("share_search", json!({"id": id, "userName": "gil", "shared": true}))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(send(&s.app, as_ed("get_search_shares", json!({"id": id}))).await.2, json!(["gil"]));

    // The guest sees the matching photos, as an album by the search's name, without the query
    let (_, _, libs) = send(&s.app, as_gil("list_libraries", json!({}))).await;
    assert_eq!((libs.as_array().unwrap().len(), &libs[0]["photos"]), (1, &json!(2)));
    let (_, _, photos) = send(&s.app, as_gil("scan_folder", json!({"folderPath": bob}))).await;
    assert_eq!(hashes_of(&photos), ["b1", "b2"]);
    let (_, _, albums) = send(&s.app, as_gil("get_albums", json!({}))).await;
    let id = id.as_i64().unwrap();
    assert_eq!(albums[0], json!({"id": -id, "name": "Bob's photos", "hashes": ["b1", "b2"], "dynamic": true}));
    assert_eq!(albums.as_array().unwrap().len(), 1, "not Holiday or Private, though their photos are visible: {albums}");
    assert_eq!(send(&s.app, as_gil("get_saved_searches", json!({}))).await.2, json!([]));
    assert!(!albums.to_string().contains("person:"), "no query in the answer");

    // A photo that stops matching goes once the albums are worked out again (the serve loop does that after
    // every change; here by hand)
    let (status, _, _) = send(&s.app, as_ed("remove_person_from_photo", json!({"hash": "b1", "name": "Bob"}))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(crate::dynamic::refresh(&s.host).await.unwrap(), "the album changed");
    assert!(!crate::dynamic::refresh(&s.host).await.unwrap(), "and is the same the second time");
    let (_, _, photos) = send(&s.app, as_gil("scan_folder", json!({"folderPath": bob}))).await;
    assert_eq!(hashes_of(&photos), ["b2"]);
    assert_eq!(send(&s.app, get("/media/thumb/b1", Some(&gil))).await.0, StatusCode::NOT_FOUND);

    // Shared by someone who may edit only Anna's library, it finds nothing in Bob's
    let mia = login(&s.app, "mia").await;
    let (status, _, _) = send(&s.app, post("/api/rpc/share_search", json!({"id": id, "userName": "gil", "shared": true}), Some(&mia))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, albums) = send(&s.app, as_gil("get_albums", json!({}))).await;
    assert_eq!(albums[0]["hashes"], json!([]));
    send(&s.app, as_ed("share_search", json!({"id": id, "userName": "gil", "shared": true}))).await;

    // Deleting the saved search takes it away at once
    let mut events = s.host.subscribe();
    let (status, _, _) = send(&s.app, as_ed("delete_saved_search", json!({"id": id}))).await;
    assert_eq!(status, StatusCode::OK);
    let (event, _) = events.recv().await.unwrap();
    assert_eq!(event, "albums-changed");
    let (event, payload) = events.recv().await.unwrap();
    assert_eq!((event.as_str(), &payload["users"]), ("shares-changed", &json!(["gil"])));
    assert!(!send(&s.app, as_gil("get_albums", json!({}))).await.2.to_string().contains("dynamic"));
    assert_eq!(send(&s.app, as_gil("scan_folder", json!({"folderPath": bob}))).await.0, StatusCode::NOT_FOUND);
}

// ---- Milestone 5: administration ----

#[tokio::test]
async fn the_admin_page_is_for_admins_only() {
    let s = server("adminonly");
    add_library(&s);
    let editor = login(&s.app, "ed").await;
    for (cmd, args) in [
        ("server_status", json!({})),
        ("admin_list_users", json!({})),
        ("admin_create_user", json!({"name": "x", "role": "viewer", "password": "long enough"})),
        ("start_library_job", json!({"rootFolder": "/", "job": "faces"})),
        ("inspect_backup", json!({"path": "upload-1.luminabackup"})),
    ] {
        assert_eq!(send(&s.app, post(&format!("/api/rpc/{cmd}"), args, Some(&editor))).await.0, StatusCode::FORBIDDEN, "{cmd}");
    }
    let upload = HttpRequest::post("/api/admin/restore").header("x-lumina", "1").header(header::COOKIE, &editor).body(Body::from("PK")).unwrap();
    assert_eq!(send(&s.app, upload).await.0, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn the_status_shows_each_librarys_backlog_and_jobs_can_be_queued() {
    let s = server("status");
    let (root, _) = add_library(&s);
    let admin = login(&s.app, "ada").await;
    let (status, _, body) = send(&s.app, post("/api/rpc/server_status", json!({}), Some(&admin))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let lib = &body["libraries"][0];
    assert_eq!((&lib["root"], &lib["photos"]), (&json!(root), &json!(1)));
    // The one photo: no face scan, no smart search vector, no caption yet; its thumbnail is too small to count
    assert_eq!((&lib["faces_pending"], &lib["smart_search_pending"], &lib["captions_pending"]), (&json!(1), &json!(1), &json!(1)));
    assert_eq!(lib["thumbnails_missing"], 1);
    assert!(body["disk"]["total"].as_u64().unwrap_or(1) > 0);

    let (status, _, _) = send(&s.app, post("/api/rpc/start_library_job", json!({"rootFolder": root, "job": "faces"}), Some(&admin))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, _, body) = send(&s.app, post("/api/rpc/server_status", json!({}), Some(&admin))).await;
    assert_eq!(body["jobs"]["queued"], json!([format!("Face scan of {root}")]));
    let (status, _, _) = send(&s.app, post("/api/rpc/start_library_job", json!({"rootFolder": root, "job": "dance"}), Some(&admin))).await;
    assert_ne!(status, StatusCode::OK);
}

#[tokio::test]
async fn accounts_are_managed_from_the_admin_page_without_locking_anyone_out() {
    let s = server("accounts");
    let (root, _) = add_library(&s);
    let admin = login(&s.app, "ada").await;
    let rpc = |cmd: &str, args: Value| post(&format!("/api/rpc/{cmd}"), args, Some(&admin));
    let mut events = s.host.subscribe();

    assert_eq!(send(&s.app, rpc("admin_create_user", json!({"name": "gwen", "role": "guest", "password": "long enough"}))).await.0, StatusCode::OK);
    let (status, _, _) = send(&s.app, rpc("admin_create_user", json!({"name": "short", "role": "guest", "password": "x"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "password rules hold here too");
    assert_eq!(send(&s.app, rpc("admin_set_library_role", json!({"name": "gwen", "rootFolder": root, "role": "editor"}))).await.0, StatusCode::OK);
    let (event, payload) = events.recv().await.unwrap();
    assert_eq!((event.as_str(), &payload["users"]), ("roles-changed", &json!(["gwen"])));
    let (_, _, users) = send(&s.app, rpc("admin_list_users", json!({}))).await;
    let gwen = users.as_array().unwrap().iter().find(|u| u["name"] == "gwen").unwrap().clone();
    assert_eq!((&gwen["role"], &gwen["libraries"]), (&json!("guest"), &json!([{"root": root, "role": "editor"}])));
    // And she can log in with it, and edit that library
    let gwen_cookie = login(&s.app, "gwen").await;
    assert_eq!(send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["abc123"], "rating": 2}), Some(&gwen_cookie))).await.0, StatusCode::OK);
    assert_eq!(send(&s.app, rpc("admin_set_library_role", json!({"name": "gwen", "rootFolder": root, "role": null}))).await.0, StatusCode::OK);
    assert_eq!(send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["abc123"], "rating": 2}), Some(&gwen_cookie))).await.0, StatusCode::FORBIDDEN);

    // A new password logs her out; then she goes
    assert_eq!(send(&s.app, rpc("admin_set_password", json!({"name": "gwen", "password": "another long one"}))).await.0, StatusCode::OK);
    assert_eq!(send(&s.app, get("/api/auth/me", Some(&gwen_cookie))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&s.app, rpc("admin_remove_user", json!({"name": "gwen"}))).await.0, StatusCode::OK);

    // The admin can't lock themselves out, and the last admin stays
    let (status, _, body) = send(&s.app, rpc("admin_set_role", json!({"name": "ada", "role": "editor"}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(send(&s.app, rpc("admin_remove_user", json!({"name": "ADA"}))).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(send(&s.app, rpc("admin_set_role", json!({"name": "vera", "role": "editor"}))).await.0, StatusCode::OK);
}

#[tokio::test]
async fn a_backup_is_uploaded_into_the_data_folder_and_named_by_the_server() {
    let s = server("upload");
    let admin = login(&s.app, "ada").await;
    let bytes = vec![42u8; 3 * 1024 * 1024];
    let upload = HttpRequest::post("/api/admin/restore")
        .header("x-lumina", "1")
        .header(header::COOKIE, &admin)
        .body(Body::from(bytes.clone()))
        .unwrap();
    let (status, _, body) = send(&s.app, upload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["file"].as_str().unwrap().to_string();
    assert_eq!(body["bytes"], json!(bytes.len()));
    assert_eq!(std::fs::read(s.dir.join("restores").join(&name)).unwrap(), bytes, "larger than the default body limit, kept whole");
    // Not a backup: a readable error, nothing restored
    let (status, _, body) = send(&s.app, post("/api/rpc/inspect_backup", json!({"path": name}), Some(&admin))).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
    // Only the server's own uploads, by name
    for path in ["../library.db", "/etc/passwd", "upload-1.luminabackup"] {
        let (status, _, body) = send(&s.app, post("/api/rpc/inspect_backup", json!({"path": path}), Some(&admin))).await;
        assert_eq!(body, json!({"error": "No such uploaded backup: upload it again"}), "{path} {status}");
    }
}

// ---- Open sockets follow sessions and shares ----

// The session token in a "lumina_session=..." cookie pair
fn token_of(cookie: &str) -> String {
    cookie.split_once('=').unwrap().1.to_string()
}

// Feeds the next events the server sends to a listener, answering what it did with each
async fn feed(listener: &mut super::events::Listener, events: &mut tokio::sync::broadcast::Receiver<(String, Value)>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok((name, payload)) = events.try_recv() {
        out.push(match listener.event(&name, payload).await {
            super::events::Step::Send(p) => format!("send {name} {}", p["hashes"]),
            super::events::Step::Skip => format!("skip {name}"),
            super::events::Step::Close => format!("close {name}"),
        });
    }
    out
}

#[tokio::test]
async fn an_open_socket_closes_when_its_user_is_removed_or_their_password_reset() {
    let s = server("socketsession");
    two_libraries(&s);
    let admin = login(&s.app, "ada").await;
    let gus = login(&s.app, "gus").await;
    let vera = login(&s.app, "vera").await;
    let mut events = s.host.subscribe();
    let mut gus_socket = super::events::Listener::open(s.host.clone(), token_of(&gus)).await.unwrap();
    let mut vera_socket = super::events::Listener::open(s.host.clone(), token_of(&vera)).await.unwrap();

    send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["b2"], "rating": 3}), Some(&admin))).await;
    assert_eq!(feed(&mut gus_socket, &mut events).await, [r#"send photos-changed ["b2"]"#]);

    // Removed: the very event that says so closes the socket, and nothing after it gets through
    send(&s.app, post("/api/rpc/admin_remove_user", json!({"name": "gus"}), Some(&admin))).await;
    send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["b2"], "rating": 4}), Some(&admin))).await;
    let answers = feed(&mut gus_socket, &mut events).await;
    assert_eq!(answers.first().map(String::as_str), Some("close roles-changed"), "{answers:?}");
    assert!(answers.iter().all(|a| a.starts_with("close")), "{answers:?}");
    assert!(!gus_socket.recheck(false).await, "and the next ping tick closes it too");

    // A new password says nothing on the socket: the ping tick finds the session gone
    assert!(vera_socket.recheck(false).await);
    send(&s.app, post("/api/rpc/admin_set_password", json!({"name": "vera", "password": "a new long one"}), Some(&admin))).await;
    assert!(!vera_socket.recheck(false).await);
    // And no other event slips through in the meantime (the session is looked at again after a second)
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["a1"], "rating": 1}), Some(&admin))).await;
    let mut vera_socket2 = super::events::Listener::open(s.host.clone(), token_of(&vera)).await;
    assert!(vera_socket2.is_none(), "the old session can't open a socket either");
    let _ = vera_socket2.take();
}

#[tokio::test]
async fn a_guests_socket_follows_photos_added_to_and_removed_from_a_shared_album() {
    let s = server("socketalbum");
    let (_, _, holiday) = two_libraries(&s);
    let admin = login(&s.app, "ada").await;
    let gus = login(&s.app, "gus").await;
    let mut events = s.host.subscribe();
    let mut socket = super::events::Listener::open(s.host.clone(), token_of(&gus)).await.unwrap();

    // b1 isn't shared yet: a change to it doesn't reach the guest
    send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["b1"], "rating": 2}), Some(&admin))).await;
    assert_eq!(feed(&mut socket, &mut events).await, ["skip photos-changed"]);

    // Added to the shared album: the guest hears about it, without reconnecting
    send(&s.app, post("/api/rpc/add_to_album", json!({"id": holiday, "hashes": ["b1"]}), Some(&admin))).await;
    assert_eq!(feed(&mut socket, &mut events).await, ["send albums-changed null", r#"send photos-changed ["b1"]"#]);
    send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["b1"], "rating": 3}), Some(&admin))).await;
    assert_eq!(feed(&mut socket, &mut events).await, [r#"send photos-changed ["b1"]"#]);

    // Taken out again: later changes to it don't reach the guest
    send(&s.app, post("/api/rpc/remove_from_album", json!({"id": holiday, "hashes": ["b1"]}), Some(&admin))).await;
    assert_eq!(feed(&mut socket, &mut events).await, ["send albums-changed null", "skip photos-changed"]);
    send(&s.app, post("/api/rpc/set_photos_rating", json!({"hashes": ["b1"], "rating": 4}), Some(&admin))).await;
    assert_eq!(feed(&mut socket, &mut events).await, ["skip photos-changed"]);
}

// ---- Phase 3, milestone 1: uploads and downloads ----

// A small real JPEG (the server indexes what arrives)
fn jpeg(seed: u8) -> Vec<u8> {
    let img = image::RgbImage::from_fn(48, 32, |x, y| image::Rgb([seed, (x * 5) as u8, (y * 7) as u8]));
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

fn content_hash(bytes: &[u8]) -> String {
    let path = std::env::temp_dir().join(format!("lumina_hash_{}_{}", std::process::id(), blake3::hash(bytes).to_hex()));
    std::fs::write(&path, bytes).unwrap();
    let (h, _) = lumina_core::imaging::hash_and_read_head(&path, bytes.len() as u64).unwrap();
    let _ = std::fs::remove_file(&path);
    h
}

fn put_chunk(id: &str, offset: usize, bytes: &[u8], cookie: &str) -> HttpRequest<Body> {
    HttpRequest::put(format!("/api/upload/{id}"))
        .header("x-lumina", "1")
        .header("upload-offset", offset.to_string())
        .header(header::COOKIE, cookie)
        .body(Body::from(bytes.to_vec()))
        .unwrap()
}

fn start_body(name: &str, bytes: &[u8]) -> Value {
    json!({"name": name, "size": bytes.len(), "hash": content_hash(bytes), "full_hash": blake3::hash(bytes).to_hex().to_string(), "modified": 1_700_000_000})
}

#[tokio::test]
async fn a_file_uploads_in_three_chunks_and_lands_in_the_users_folder_indexed() {
    let s = server("upload3");
    let (root, _) = add_library(&s);
    let ed = login(&s.app, "ed").await;
    let bytes = jpeg(10);
    let mut events = s.host.subscribe();

    let (_, _, check) = send(&s.app, post("/api/upload/check", json!({"files": [{"hash": content_hash(&bytes), "size": bytes.len(), "name": "beach.jpg"}]}), Some(&ed))).await;
    assert_eq!(check["missing"].as_array().unwrap().len(), 1, "not on the server yet");

    let (status, _, started) = send(&s.app, post("/api/upload", start_body("beach.jpg", &bytes), Some(&ed))).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let id = started["id"].as_str().unwrap().to_string();
    let third = bytes.len() / 3 + 1;
    for (i, part) in bytes.chunks(third).enumerate() {
        let (status, _, body) = send(&s.app, put_chunk(&id, i * third, part, &ed)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (_, _, progress) = send(&s.app, get(&format!("/api/upload/{id}"), Some(&ed))).await;
    assert_eq!((&progress["received"], &progress["size"]), (&json!(bytes.len()), &json!(bytes.len())));

    let (status, _, photo) = send(&s.app, post(&format!("/api/upload/{id}/finish"), json!({}), Some(&ed))).await;
    assert_eq!(status, StatusCode::OK, "{photo}");
    let landed = std::path::Path::new(&root).join("uploads").join("ed").join("beach.jpg");
    assert_eq!(std::fs::read(&landed).unwrap(), bytes);
    assert_eq!(photo["name"], "beach.jpg");
    assert_eq!(photo["hash"], json!(content_hash(&bytes)));
    let mtime = landed.metadata().unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    assert_eq!(mtime, 1_700_000_000, "the file keeps its own time");
    // The upload's thumbnail pass may report first
    let payload = loop {
        let (event, payload) = events.recv().await.unwrap();
        if event == "photos-changed" {
            break payload;
        }
    };
    assert_eq!(payload["hashes"], json!([content_hash(&bytes)]));

    // Now the server has it
    let (_, _, check) = send(&s.app, post("/api/upload/check", json!({"files": [{"hash": content_hash(&bytes), "size": bytes.len(), "name": "x.jpg"}]}), Some(&ed))).await;
    assert_eq!(check["missing"], json!([]));
    let (_, _, has) = send(&s.app, post("/api/rpc/content_hashes", json!({"hashes": [content_hash(&bytes), "abc123", "nothere"]}), Some(&ed))).await;
    assert_eq!(has, json!([content_hash(&bytes), "abc123"]));
    // And nothing is left behind in incoming/
    assert_eq!(std::fs::read_dir(s.dir.join("incoming")).unwrap().count(), 0);
}

#[tokio::test]
async fn an_upload_resumes_refuses_a_wrong_offset_and_keeps_names_apart() {
    let s = server("uploadresume");
    let (root, _) = add_library(&s);
    let ed = login(&s.app, "ed").await;
    let bytes = jpeg(20);
    let (_, _, first) = send(&s.app, post("/api/upload", start_body("a.jpg", &bytes), Some(&ed))).await;
    let id = first["id"].as_str().unwrap().to_string();
    send(&s.app, put_chunk(&id, 0, &bytes[..100], &ed)).await;

    // Starting the same file again carries on where it stopped
    let (_, _, again) = send(&s.app, post("/api/upload", start_body("a.jpg", &bytes), Some(&ed))).await;
    assert_eq!((&again["id"], &again["received"]), (&json!(id), &json!(100)));
    // A chunk at the wrong place: 409 with where to carry on
    let (status, _, body) = send(&s.app, put_chunk(&id, 50, &bytes[50..150], &ed)).await;
    assert_eq!((status, &body["offset"]), (StatusCode::CONFLICT, &json!(100)));
    // Finishing early says so
    assert_eq!(send(&s.app, post(&format!("/api/upload/{id}/finish"), json!({}), Some(&ed))).await.0, StatusCode::CONFLICT);
    send(&s.app, put_chunk(&id, 100, &bytes[100..], &ed)).await;
    // The library already has an a.jpg (the test photo): this one becomes "a (2).jpg"... in the user's folder
    std::fs::create_dir_all(std::path::Path::new(&root).join("uploads").join("ed")).unwrap();
    std::fs::write(std::path::Path::new(&root).join("uploads").join("ed").join("a.jpg"), b"someone else").unwrap();
    let (status, _, photo) = send(&s.app, post(&format!("/api/upload/{id}/finish"), json!({}), Some(&ed))).await;
    assert_eq!((status, &photo["name"]), (StatusCode::OK, &json!("a (2).jpg")), "{photo}");
    assert_eq!(std::fs::read(std::path::Path::new(&root).join("uploads").join("ed").join("a.jpg")).unwrap(), b"someone else", "never overwritten");

    // Someone else's upload id is "not found"
    let other = login(&s.app, "ada").await;
    let (_, _, mine) = send(&s.app, post("/api/upload", start_body("b.jpg", &jpeg(21)), Some(&ed))).await;
    let mine = mine["id"].as_str().unwrap();
    assert_eq!(send(&s.app, get(&format!("/api/upload/{mine}"), Some(&other))).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_damaged_upload_is_not_kept_and_a_viewer_may_not_upload() {
    let s = server("uploadbad");
    let (root, _) = add_library(&s);
    let ed = login(&s.app, "ed").await;
    let bytes = jpeg(30);
    let mut body = start_body("c.jpg", &bytes);
    body["full_hash"] = json!(blake3::hash(b"something else").to_hex().to_string());
    let (_, _, started) = send(&s.app, post("/api/upload", body, Some(&ed))).await;
    let id = started["id"].as_str().unwrap().to_string();
    send(&s.app, put_chunk(&id, 0, &bytes, &ed)).await;
    let (status, _, err) = send(&s.app, post(&format!("/api/upload/{id}/finish"), json!({}), Some(&ed))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{err}");
    assert!(!std::path::Path::new(&root).join("uploads").join("ed").join("c.jpg").exists());
    assert_eq!(std::fs::read_dir(s.dir.join("incoming")).unwrap().count(), 0, "the part is removed");
    assert_eq!(send(&s.app, get(&format!("/api/upload/{id}"), Some(&ed))).await.0, StatusCode::NOT_FOUND);

    // Not a photo, a path for a name
    let (status, _, _) = send(&s.app, post("/api/upload", start_body("notes.txt", &bytes), Some(&ed))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, _, sneaky) = send(&s.app, post("/api/upload", start_body("../../etc/x.jpg", &jpeg(31)), Some(&ed))).await;
    let sid = sneaky["id"].as_str().unwrap().to_string();
    send(&s.app, put_chunk(&sid, 0, &jpeg(31), &ed)).await;
    let (_, _, photo) = send(&s.app, post(&format!("/api/upload/{sid}/finish"), json!({}), Some(&ed))).await;
    assert_eq!(photo["name"], "x.jpg", "only the file's own name is used");

    let vera = login(&s.app, "vera").await;
    for req in [
        post("/api/upload/check", json!({"files": []}), Some(&vera)),
        post("/api/upload", start_body("d.jpg", &bytes), Some(&vera)),
    ] {
        assert_eq!(send(&s.app, req).await.0, StatusCode::FORBIDDEN);
    }
}

#[tokio::test]
async fn a_download_is_the_original_with_its_blake3_and_follows_who_may_see_it() {
    let s = server("download");
    two_libraries(&s);
    let ada = login(&s.app, "ada").await;
    let gus = login(&s.app, "gus").await;
    let (status, headers, body) = send(&s.app, get("/media/download/b1", Some(&ada))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Value::String("photo".into()));
    assert_eq!(headers.get("x-lumina-blake3").unwrap(), blake3::hash(b"photo").to_hex().as_str());
    assert_eq!(headers.get("content-disposition").unwrap(), "attachment; filename=\"b1.jpg\"; filename*=UTF-8''b1.jpg");
    let range = HttpRequest::get("/media/download/b1").header(header::COOKIE, &ada).header(header::RANGE, "bytes=1-2").body(Body::empty()).unwrap();
    let (status, headers, body) = send(&s.app, range).await;
    assert_eq!((status, body), (StatusCode::PARTIAL_CONTENT, Value::String("ho".into())));
    assert_eq!(headers.get("x-lumina-blake3").unwrap(), blake3::hash(b"photo").to_hex().as_str(), "the whole file's, also for a part");
    // The guest: only what is shared (b2), not b1
    assert_eq!(send(&s.app, get("/media/download/b2", Some(&gus))).await.0, StatusCode::OK);
    assert_eq!(send(&s.app, get("/media/download/b1", Some(&gus))).await.0, StatusCode::NOT_FOUND);
    let (_, _, has) = send(&s.app, post("/api/rpc/content_hashes", json!({"hashes": ["a1", "b1", "b2"]}), Some(&gus))).await;
    assert_eq!(has, json!(["b2"]));
}

#[tokio::test]
async fn a_partial_upload_untouched_for_a_week_is_given_up() {
    let s = server("uploadold");
    add_library(&s);
    let ed = login(&s.app, "ed").await;
    let (_, _, old) = send(&s.app, post("/api/upload", start_body("old.jpg", &jpeg(40)), Some(&ed))).await;
    let old = old["id"].as_str().unwrap().to_string();
    send(&s.app, put_chunk(&old, 0, &jpeg(40)[..10], &ed)).await;
    // Eight days without a chunk
    let part = s.dir.join("incoming").join(format!("{old}.part"));
    let week_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 24 * 3600);
    std::fs::OpenOptions::new().write(true).open(&part).unwrap().set_modified(week_ago).unwrap();
    let conn = db::open_global_db(&*s.host).unwrap();
    conn.execute("UPDATE uploads SET created_at = created_at - 8 * 86400 WHERE id = ?1", [&old]).unwrap();
    // The next upload that starts tidies up
    send(&s.app, post("/api/upload", start_body("new.jpg", &jpeg(41)), Some(&ed))).await;
    assert!(!part.exists());
    assert_eq!(send(&s.app, get(&format!("/api/upload/{old}"), Some(&ed))).await.0, StatusCode::NOT_FOUND);
}

// Thumbnails and face crops are named by their place in the data folder, not where it is on the server; a
// library inside the data folder keeps its full paths
#[tokio::test]
async fn answers_name_cache_files_without_the_data_folder() {
    let s = server("datadir");
    let (_, bob, _) = two_libraries(&s);
    let vera = login(&s.app, "vera").await;
    let (_, _, photos) = send(&s.app, post("/api/rpc/scan_folder", json!({"folderPath": bob}), Some(&vera))).await;
    let b2 = photos.as_array().unwrap().iter().find(|p| p["hash"] == "b2").unwrap();
    assert_eq!(b2["thumb_path"], json!(format!("thumbnails{}b2.jpg", std::path::MAIN_SEPARATOR)));
    assert_eq!(b2["faces"][0]["face_thumb"], json!(format!("faces{}b2_1_1.jpg", std::path::MAIN_SEPARATOR)));
    assert_eq!(b2["path"], json!(std::path::Path::new(&bob).join("b2.jpg").to_string_lossy()));
}
