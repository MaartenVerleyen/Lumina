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
    let state = Arc::new(AppState { host, web_dir: Some(web), throttle: Default::default() });
    let app = router(state).layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 50000))));
    TestServer { app, dir }
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
        send(&s.app, post("/api/rpc/semantic_status", json!({"rootFolder": "/photos"}), Some(&admin))).await;
    assert_eq!(status, StatusCode::OK);
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
        assert!(csp.contains("script-src 'self'") && csp.contains("frame-ancestors 'none'"));
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
const STILL_TO_COME: &[&str] = &[
    "add_person_to_photos", "add_tag_batch", "add_to_album", "ai_analyze_photo",
    "assign_face_region_and_automatch", "assign_faces_to_person_batch", "cancel_ai_analysis",
    "cancel_face_scan", "cancel_semantic_index", "cancel_thumbnail_pass", "clear_all_staged",
    "clear_video_cache", "commit_staged_operations", "delete_album", "delete_saved_search",
    "detect_faces_in_photo", "empty_library_trash_to_os", "export_xmp_sidecars", "find_duplicates",
    "find_similar_faces", "get_library_health_stats", "get_outdated_face_photos",
    "get_pending_face_match_counts", "get_rejected_faces_for_person", "get_unknown_face_clusters",
    "ignore_faces", "inspect_backup", "measure_face_quality", "ollama_tuning_status", "preload_ollama_vram",
    "prune_orphaned_cache", "pull_ollama_model", "reject_face_candidates_batch", "remove_face_box",
    "remove_from_album", "remove_person_from_photo", "remove_person_from_photos", "remove_tag",
    "remove_tag_batch", "rename_album", "rename_person", "rescan_exif_batch", "restore_library",
    "run_caption_batch", "save_search", "scan_library_faces_batch", "set_manual_location", "set_person_cover",
    "set_person_hidden", "set_person_starred", "set_photo_basket", "set_photo_color_label", "set_photo_flag",
    "set_photo_rotation", "set_photos_rating", "set_photos_rotation_exact", "set_trip_name",
    "shift_capture_timestamps", "stage_duplicate_extras", "stage_photo_move", "stage_photos_move",
    "start_semantic_index", "trash_summary", "unassign_faces_batch", "unload_ollama_vram",
    "unreject_face_candidates_batch", "video_cache_info",
];

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
