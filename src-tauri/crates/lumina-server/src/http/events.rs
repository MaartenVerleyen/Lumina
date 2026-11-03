// GET /api/events: a WebSocket with every engine event as {"event": ..., "payload": ...}, the way the desktop's
// frontend receives them from Tauri. The session check in front of /api covers it (the browser sends the
// cookie with the upgrade request).
//
// A user who sees only part of the server (roles per library, or a guest of shared albums) gets only what
// names nothing else: photos-changed cut down to the photos they see, the "refresh" events (people, albums,
// shares, roles, files changed in a library), and none of the progress events, which carry other photos'
// names and faces.
//
// The session is checked again while the socket is open (every ping, at most once a second on events, and
// always on the events that change what someone may see), so a removed user, a reset password or an ended
// session closes the socket instead of letting events through.
use super::{session_token, Shared};
use crate::accounts::{self, User};
use crate::host::ServerHost;
use crate::scope::Scope;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum_extra::extract::CookieJar;
use lumina_core::db;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::RecvError;

pub async fn events(
    State(state): State<Shared>,
    Extension(user): Extension<User>,
    jar: CookieJar,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let rx = state.host.subscribe();
    let host = state.host.clone();
    // The session check in front of /api already found the token
    let token = session_token(&jar, &headers).unwrap_or_default();
    ws.on_upgrade(move |socket| forward(socket, rx, host, user, token))
}

// The events that only say "look again" and name no photo
const REFRESH_EVENTS: &[&str] = &["people-changed", "albums-changed", "shares-changed", "roles-changed", "library-files-changed"];
// The ones after which what a user may see can differ: the session and scope are looked at again first
const SCOPE_EVENTS: &[&str] = &["albums-changed", "shares-changed", "roles-changed"];
const SESSION_RECHECK: Duration = Duration::from_secs(1);

pub(super) async fn load_scope(host: &Arc<ServerHost>, user: &User) -> Option<Arc<Scope>> {
    let (host, user) = (host.clone(), user.clone());
    tokio::task::spawn_blocking(move || Scope::load(&db::open_global_db(&*host).ok()?, &user).ok().map(Arc::new)).await.ok().flatten()
}

// The session's user as the database has them now (None: logged out, removed, password changed, expired)
async fn session_user(host: &Arc<ServerHost>, token: &str) -> Option<User> {
    let (host, token) = (host.clone(), token.to_string());
    tokio::task::spawn_blocking(move || accounts::session_user(&db::open_global_db(&*host).ok()?, &token).ok().flatten())
        .await
        .ok()
        .flatten()
}

// What of this event this user may get (None: nothing)
pub(super) async fn for_user(host: &Arc<ServerHost>, scope: &Arc<Scope>, name: &str, payload: JsonValue) -> Option<JsonValue> {
    if scope.sees_all() || REFRESH_EVENTS.contains(&name) {
        return Some(payload);
    }
    if name != "photos-changed" {
        return None;
    }
    let hashes: Vec<String> = payload["hashes"].as_array()?.iter().filter_map(|h| h.as_str().map(str::to_string)).collect();
    let (host, scope2) = (host.clone(), scope.clone());
    let visible = tokio::task::spawn_blocking(move || scope2.visible(&db::open_global_db(&*host).ok()?, &hashes).ok())
        .await
        .ok()
        .flatten()?;
    if visible.is_empty() {
        return None;
    }
    let mut payload = payload;
    payload["hashes"] = serde_json::json!(visible);
    Some(payload)
}

// One open socket's view: whose session it is, and what they may see
pub(super) struct Listener {
    host: Arc<ServerHost>,
    token: String,
    user: User,
    scope: Arc<Scope>,
    checked: Instant,
    // Once the session is gone it stays gone: nothing more goes out
    closed: bool,
}

pub(super) enum Step {
    Send(JsonValue),
    Skip,
    Close,
}

impl Listener {
    pub(super) async fn open(host: Arc<ServerHost>, token: String) -> Option<Listener> {
        let user = session_user(&host, &token).await?;
        let scope = load_scope(&host, &user).await?;
        Some(Listener { host, token, user, scope, checked: Instant::now(), closed: false })
    }

    // Looks at the session again, and the scope with it when asked (false: close the socket)
    pub(super) async fn recheck(&mut self, reload_scope: bool) -> bool {
        if self.closed {
            return false;
        }
        let Some(user) = session_user(&self.host, &self.token).await else {
            self.closed = true;
            return false;
        };
        self.checked = Instant::now();
        // A changed role shows in the user too
        let changed = user.role != self.user.role;
        self.user = user;
        if reload_scope || changed {
            let Some(scope) = load_scope(&self.host, &self.user).await else {
                self.closed = true;
                return false;
            };
            self.scope = scope;
        }
        true
    }

    pub(super) async fn event(&mut self, name: &str, payload: JsonValue) -> Step {
        let rescope = SCOPE_EVENTS.contains(&name);
        if self.closed {
            return Step::Close;
        }
        if (rescope || self.checked.elapsed() >= SESSION_RECHECK) && !self.recheck(rescope).await {
            return Step::Close;
        }
        match for_user(&self.host, &self.scope, name, payload).await {
            Some(payload) => Step::Send(payload),
            None => Step::Skip,
        }
    }
}

async fn forward(
    mut socket: WebSocket,
    mut rx: tokio::sync::broadcast::Receiver<(String, serde_json::Value)>,
    host: Arc<ServerHost>,
    _user: User,
    token: String,
) {
    let Some(mut listener) = Listener::open(host, token).await else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    // A ping now and then keeps proxies (tailscale serve) from closing a quiet connection
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok((name, payload)) => match listener.event(&name, payload).await {
                    Step::Send(payload) => {
                        let text = serde_json::json!({ "event": name, "payload": payload }).to_string();
                        if socket.send(Message::Text(text.into())).await.is_err() {
                            return;
                        }
                    }
                    Step::Skip => {}
                    Step::Close => {
                        let _ = socket.send(Message::Close(None)).await;
                        return;
                    }
                },
                // A slow client misses some progress events; the next ones still come
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if !listener.recheck(false).await {
                    let _ = socket.send(Message::Close(None)).await;
                    return;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
        }
    }
}
