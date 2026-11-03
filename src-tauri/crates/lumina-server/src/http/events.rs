// GET /api/events: a WebSocket with every engine event as {"event": ..., "payload": ...}, the way the desktop's
// frontend receives them from Tauri. The session check in front of /api covers it (the browser sends the
// cookie with the upgrade request).
//
// A user who sees only part of the server (roles per library, or a guest of shared albums) gets only what
// names nothing else: photos-changed cut down to the photos they see, the "refresh" events (people, albums,
// shares, roles, files changed in a library), and none of the progress events, which carry other photos'
// names and faces.
use super::Shared;
use crate::accounts::User;
use crate::host::ServerHost;
use crate::scope::Scope;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, State};
use axum::response::Response;
use lumina_core::db;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

pub async fn events(State(state): State<Shared>, Extension(user): Extension<User>, ws: WebSocketUpgrade) -> Response {
    let rx = state.host.subscribe();
    let host = state.host.clone();
    ws.on_upgrade(move |socket| forward(socket, rx, host, user))
}

// The events that only say "look again" and name no photo
const REFRESH_EVENTS: &[&str] = &["people-changed", "albums-changed", "shares-changed", "roles-changed", "library-files-changed"];

pub(super) async fn load_scope(host: &Arc<ServerHost>, user: &User) -> Option<Arc<Scope>> {
    let (host, user) = (host.clone(), user.clone());
    tokio::task::spawn_blocking(move || Scope::load(&db::open_global_db(&*host).ok()?, &user).ok().map(Arc::new)).await.ok().flatten()
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

async fn forward(
    mut socket: WebSocket,
    mut rx: tokio::sync::broadcast::Receiver<(String, serde_json::Value)>,
    host: Arc<ServerHost>,
    user: User,
) {
    let Some(mut scope) = load_scope(&host, &user).await else { return };
    // A ping now and then keeps proxies (tailscale serve) from closing a quiet connection
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok((name, payload)) => {
                    // Shares and roles decide what this user sees: look again before passing on anything else
                    if name == "shares-changed" || name == "roles-changed" {
                        if let Some(fresh) = load_scope(&host, &user).await {
                            scope = fresh;
                        }
                    }
                    let Some(payload) = for_user(&host, &scope, &name, payload).await else { continue };
                    let text = serde_json::json!({ "event": name, "payload": payload }).to_string();
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        return;
                    }
                }
                // A slow client misses some progress events; the next ones still come
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
        }
    }
}
