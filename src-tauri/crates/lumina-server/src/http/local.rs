// GET /local/status: what the server is doing, for the tray on the server's own computer (lumina-tray). The
// tray has no account: it shows the key the server writes in its data folder when it starts
// (local-access.key, readable only by the user the server runs as), and asks from this machine or a local
// proxy (Docker's bridge). The answer is the admin page's status.
use super::{admin, ApiError, Shared};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::Value as JsonValue;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::OnceLock;

pub const KEY_FILE: &str = "local-access.key";
static KEY: OnceLock<String> = OnceLock::new();

// A new key each start, so an old copy of the file opens nothing
pub fn create_key(data_dir: &Path) -> Result<(), String> {
    let bytes: [u8; 32] = rand::random();
    let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let path = data_dir.join(KEY_FILE);
    std::fs::write(&path, &key).map_err(|e| format!("Can't write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let _ = KEY.set(key);
    Ok(())
}

fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub async fn status(State(state): State<Shared>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Result<Json<JsonValue>, ApiError> {
    let local = match peer.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    };
    let given = headers.get("x-lumina-local-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    let ok = local && KEY.get().is_some_and(|key| same(key, given.trim()));
    if !ok {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "Only the tray on the server's computer may ask this"));
    }
    Ok(Json(admin::status(&state.host).await?))
}
