// POST /api/rpc/{command}: the desktop's engine commands, by the same names and with the same JSON the
// frontend sends to Tauri's invoke (camelCase arguments), each with the lowest role allowed to call it.
// Commands not in the table don't exist on the server (404).
use super::{ApiError, Shared};
use crate::accounts::{Role, User};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Extension, Json};
use lumina_core::host::SharedHost;
use lumina_core::{albums, clip};
use serde::de::DeserializeOwned;
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;

type CallFuture = Pin<Box<dyn Future<Output = Result<JsonValue, ApiError>> + Send>>;

pub struct Command {
    pub name: &'static str,
    pub role: Role,
    call: fn(SharedHost, JsonValue) -> CallFuture,
}

fn parse_args<T: DeserializeOwned>(args: JsonValue) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad arguments: {e}")))
}

fn answer<T: serde::Serialize>(result: Result<T, String>) -> Result<JsonValue, ApiError> {
    let value = result.map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    serde_json::to_value(value).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// One line per command:
//   ROLE async|blocking NAME(arg: Type, ...) |host| expression giving Result<T, String>;
// `async` expressions may .await; `blocking` ones run on a blocking thread (SQLite, files).
macro_rules! commands {
    ($( $role:ident $kind:ident $name:ident ( $($arg:ident : $ty:ty),* $(,)? ) |$host:ident| $body:expr ; )*) => {
        pub static COMMANDS: &[Command] = &[
            $( Command {
                name: stringify!($name),
                role: Role::$role,
                call: |$host, args| Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $( $arg: $ty ),* }
                    #[allow(unused_variables)]
                    let Args { $( $arg ),* } = parse_args::<Args>(args)?;
                    commands!(@run $kind $body)
                }),
            } ),*
        ];
    };
    (@run async $body:expr) => { answer($body) };
    (@run blocking $body:expr) => {
        answer(tokio::task::spawn_blocking(move || $body).await.map_err(|e| e.to_string()).and_then(|r| r))
    };
}

commands! {
    Viewer async semantic_status(root_folder: Option<String>) |host| clip::semantic_status(host, root_folder).await;
    Viewer blocking get_albums() |host| albums::get_albums(host);
    Editor blocking create_album(name: String) |host| albums::create_album(host, name);
}

pub fn lookup(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name)
}

pub async fn call(
    State(state): State<Shared>,
    Extension(user): Extension<User>,
    Path(command): Path<String>,
    body: Bytes,
) -> Result<Json<JsonValue>, ApiError> {
    let cmd = lookup(&command).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Unknown command: {command}")))?;
    if user.role < cmd.role {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("{command} needs the {} role", cmd.role.as_str())));
    }
    let args = if body.iter().all(|b| b.is_ascii_whitespace()) {
        serde_json::json!({})
    } else {
        serde_json::from_slice(&body).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad JSON: {e}")))?
    };
    let host: SharedHost = state.host.clone();
    Ok(Json((cmd.call)(host, args).await?))
}
