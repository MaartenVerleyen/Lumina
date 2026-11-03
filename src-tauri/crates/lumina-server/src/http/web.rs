// The web client: the same Vite build as the desktop, served from `web_dir`, with index.html for every path
// that isn't a file (the app routes in the browser).
use axum::http::{HeaderName, HeaderValue, StatusCode};
use axum::response::IntoResponse;
use super::Shared;
use axum::Router;
use std::path::Path;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

// Close to the desktop's (src-tauri/tauri.conf.json), with the page's own origin in place of Tauri's ipc: and
// asset: schemes. 'self' covers the WebSocket to the same host as well. Map tiles come from OpenStreetMap.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob: https://*.tile.openstreetmap.org; media-src 'self' blob:; connect-src 'self'; \
font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

// The web client's files as the router's fallback, or a short note when there is no built client
pub fn attach(router: Router<Shared>, web_dir: Option<&Path>) -> Router<Shared> {
    match web_dir.filter(|d| d.join("index.html").is_file()) {
        Some(dir) => router.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")))),
        None => router.fallback(|| async {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "The web client isn't installed: build it (npm run build) and point web_dir or LUMINA_WEB_DIR at the dist folder.",
            )
                .into_response()
        }),
    }
}

// Security headers on every answer (a handler can set its own first)
pub fn with_security_headers(router: axum::Router) -> axum::Router {
    let header = |name: &'static str, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(HeaderName::from_static(name), HeaderValue::from_static(value))
    };
    router
        .layer(header("content-security-policy", CONTENT_SECURITY_POLICY))
        .layer(header("x-content-type-options", "nosniff"))
        // OpenStreetMap's tile servers refuse tiles without a Referer: send the origin only, never the path
        .layer(header("referrer-policy", "strict-origin"))
        .layer(header("x-frame-options", "DENY"))
}
