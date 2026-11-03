// The server on the network: the web client's files, login, and the engine's commands as
// POST /api/rpc/{command}. It listens on 127.0.0.1 only; `tailscale serve` puts HTTPS in front of it.
mod auth;
mod events;
mod lookup;
mod media;
mod rpc;
mod web;

use crate::accounts::{self, User};
use crate::host::ServerHost;
use crate::throttle::LoginThrottle;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::CookieJar;
use lumina_core::db;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

pub const SESSION_COOKIE: &str = "lumina_session";

pub struct AppState {
    pub host: Arc<ServerHost>,
    pub web_dir: Option<PathBuf>,
    pub throttle: LoginThrottle,
}

pub type Shared = Arc<AppState>;

// An error answer: {"error": "..."} with a status. 400 bad arguments, 401 not logged in, 403 not allowed,
// 404 unknown, 500 the engine's own error text.
#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> ApiError {
        ApiError(status, message.into())
    }
}

// The engine's own error text: 500
impl From<String> for ApiError {
    fn from(message: String) -> ApiError {
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}

// Runs blocking work (SQLite, password hashing, engine calls) off the async threads
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, ApiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))
}

pub fn router(state: Shared) -> Router {
    let api = Router::new()
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/rpc/{command}", post(rpc::call))
        .route("/events", get(events::events))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "Unknown API route") })
        .layer(middleware::from_fn_with_state(state.clone(), require_session))
        .layer(middleware::from_fn(require_lumina_header));
    let media = Router::new()
        .route("/thumb/{hash}", get(media::thumb))
        .route("/original/{hash}", get(media::original))
        .route("/preview/{hash}", get(media::preview))
        .route("/face/{face_id}", get(media::face))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "No such media") })
        .layer(middleware::from_fn_with_state(state.clone(), require_session));
    let app = web::attach(Router::new().nest("/api", api).nest("/media", media), state.web_dir.as_deref())
        .layer(middleware::from_fn(log_request))
        .with_state(state);
    web::with_security_headers(app)
}

// The client's own address: behind `tailscale serve` every connection comes from 127.0.0.1 (or, in Docker,
// from the bridge network's gateway), and the real one is in X-Forwarded-For. That header is believed only
// from such a local proxy; the server listens on 127.0.0.1 (or a published 127.0.0.1 port) only, so nobody
// else reaches it directly. If `listen` is ever opened to a LAN, a LAN client could pick its own address for
// the login throttle (the per-name wait still applies).
fn is_local_proxy(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        std::net::IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

pub fn client_addr(peer: Option<SocketAddr>, headers: &HeaderMap) -> String {
    let forwarded = || {
        headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(',').next())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    match peer {
        Some(p) if is_local_proxy(p.ip()) => forwarded().unwrap_or_else(|| p.ip().to_string()),
        Some(p) => p.ip().to_string(),
        None => forwarded().unwrap_or_else(|| "unknown".to_string()),
    }
}

// The session token from the cookie (browsers) or `Authorization: Bearer` (apps, from phase 3 on)
pub fn session_token(jar: &CookieJar, headers: &HeaderMap) -> Option<String> {
    if let Some(c) = jar.get(SESSION_COOKIE) {
        return Some(c.value().to_string());
    }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t.trim().to_string())
}

// Whose request it was, for the log line (the session check puts it on the response)
#[derive(Clone)]
struct LoggedUser(String);

// Everything under /api and /media needs a session, except logging in
async fn require_session(State(state): State<Shared>, jar: CookieJar, mut req: Request, next: Next) -> Response {
    // Nested routers see the path without their prefix
    if req.uri().path() == "/auth/login" {
        return next.run(req).await;
    }
    let Some(token) = session_token(&jar, req.headers()) else {
        return ApiError::new(StatusCode::UNAUTHORIZED, "Not logged in").into_response();
    };
    let host = state.host.clone();
    let user = blocking(move || {
        let conn = db::open_global_db(&*host)?;
        accounts::session_user(&conn, &token)
    })
    .await;
    match user {
        Ok(Some(user)) => {
            let name = user.name.clone();
            req.extensions_mut().insert::<User>(user);
            let mut resp = next.run(req).await;
            resp.extensions_mut().insert(LoggedUser(name));
            resp
        }
        Ok(None) => ApiError::new(StatusCode::UNAUTHORIZED, "Not logged in").into_response(),
        Err(e) => e.into_response(),
    }
}

// A request that changes something must carry `X-Lumina: 1`. A page on another site can make a browser send
// a form or a simple POST with the user's cookie, but not with a custom header.
async fn require_lumina_header(req: Request, next: Next) -> Response {
    let reads = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !reads && req.headers().get("x-lumina").and_then(|v| v.to_str().ok()) != Some("1") {
        return ApiError::new(StatusCode::FORBIDDEN, "Missing the X-Lumina: 1 header").into_response();
    }
    next.run(req).await
}

// One line per request: who, what, status, time. Never the query string, a cookie or a body.
async fn log_request(req: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
    let addr = client_addr(peer, req.headers());
    let resp = next.run(req).await;
    let user = resp.extensions().get::<LoggedUser>().map(|u| u.0.clone()).unwrap_or_else(|| "-".to_string());
    // The web client's own files are not worth a line each
    if path.starts_with("/api/") || path.starts_with("/media/") || resp.status().is_server_error() {
        println!(
            "[http] {addr} {user} {method} {path} {} {} ms",
            resp.status().as_u16(),
            started.elapsed().as_millis()
        );
    }
    resp
}

#[cfg(test)]
mod tests;
