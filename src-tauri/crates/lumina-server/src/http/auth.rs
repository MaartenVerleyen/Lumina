// POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me
use super::{blocking, client_addr, session_token, ApiError, Shared, SESSION_COOKIE};
use crate::accounts::{self, User, SESSION_IDLE_DAYS};
use axum::body::Bytes;
use axum::extract::{ConnectInfo, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use axum_extra::extract::cookie::{Cookie, SameSite};
use axum_extra::extract::CookieJar;
use lumina_core::db;
use serde::Deserialize;
use std::net::SocketAddr;

#[derive(Deserialize)]
struct LoginBody {
    name: String,
    password: String,
}

const WRONG_LOGIN: &str = "Wrong name or password";

pub async fn login(
    State(state): State<Shared>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    body: Bytes,
) -> Result<(CookieJar, Json<User>), Response> {
    let body: LoginBody = serde_json::from_slice(&body)
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Send {\"name\": ..., \"password\": ...}").into_response())?;
    let addr = client_addr(Some(peer), &headers);

    if let Err(wait) = state.throttle.begin(&body.name, &addr) {
        return Err(too_many_attempts(wait));
    }

    let device = headers.get("user-agent").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let host = state.host.clone();
    let (name, password) = (body.name.clone(), body.password);
    let session = blocking(move || {
        let conn = db::open_global_db(&*host)?;
        let Some(user) = accounts::verify_login(&conn, &name, &password)? else { return Ok(None) };
        let token = accounts::create_session(&conn, &user, &device)?;
        Ok(Some((user, token)))
    })
    .await
    .map_err(IntoResponse::into_response)?;

    let Some((user, token)) = session else {
        state.throttle.failed(&body.name, &addr);
        println!("[auth] failed login from {addr}");
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, WRONG_LOGIN).into_response());
    };
    state.throttle.succeeded(&body.name, &addr);
    println!("[auth] {} logged in from {addr}", user.name);
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .secure(true)
        .same_site(SameSite::Strict)
        .path("/")
        .max_age(time_days(SESSION_IDLE_DAYS));
    Ok((jar.add(cookie), Json(user)))
}

// 429 with Retry-After in whole seconds (at least 1), and the same in words for the login screen
fn too_many_attempts(wait: std::time::Duration) -> Response {
    let seconds = wait.as_secs_f64().ceil().max(1.0) as u64;
    let message = format!("Too many attempts. Try again in {seconds} second{}.", if seconds == 1 { "" } else { "s" });
    let mut response = ApiError::new(StatusCode::TOO_MANY_REQUESTS, message).into_response();
    response.headers_mut().insert(header::RETRY_AFTER, seconds.into());
    response
}

fn time_days(days: i64) -> time::Duration {
    time::Duration::days(days)
}

pub async fn logout(State(state): State<Shared>, headers: HeaderMap, jar: CookieJar) -> Result<(CookieJar, Json<serde_json::Value>), ApiError> {
    if let Some(token) = session_token(&jar, &headers) {
        let host = state.host.clone();
        blocking(move || {
            let conn = db::open_global_db(&*host)?;
            accounts::delete_session(&conn, &token)
        })
        .await?;
    }
    Ok((jar.remove(Cookie::build(SESSION_COOKIE).path("/")), Json(serde_json::json!({ "ok": true }))))
}

pub async fn me(Extension(user): Extension<User>) -> Json<User> {
    Json(user)
}
