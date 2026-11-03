// GET /api/events: a WebSocket with every engine event as {"event": ..., "payload": ...}, the way the desktop's
// frontend receives them from Tauri. The session check in front of /api covers it (the browser sends the
// cookie with the upgrade request).
use super::Shared;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use std::time::Duration;
use tokio::sync::broadcast::error::RecvError;

pub async fn events(State(state): State<Shared>, ws: WebSocketUpgrade) -> Response {
    let rx = state.host.subscribe();
    ws.on_upgrade(move |socket| forward(socket, rx))
}

async fn forward(mut socket: WebSocket, mut rx: tokio::sync::broadcast::Receiver<(String, serde_json::Value)>) {
    // A ping now and then keeps proxies (tailscale serve) from closing a quiet connection
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok((name, payload)) => {
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
