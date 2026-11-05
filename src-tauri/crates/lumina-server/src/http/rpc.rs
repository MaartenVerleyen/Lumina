// POST /api/rpc/{command}: the desktop's engine commands, by the same names and with the same JSON the
// frontend sends to Tauri's invoke (camelCase arguments), each with the lowest role allowed to call it.
// Commands not in the table don't exist on the server (404).
use super::{ApiError, Shared};
use crate::accounts::{Role, User};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use lumina_core::host::Host;
use axum::{Extension, Json};
use super::lookup;
use crate::host::ServerHost;
use super::access::{self, Target};
use crate::scope::{self, Scope};
use crate::dynamic;
use super::admin;
use crate::pipeline::Job;
use crate::restore;
use crate::{accounts, changes};
use lumina_core::types::PersonItem;
use std::sync::Arc;
use lumina_core::{ai, albums, backup, clip, db, decode, duplicates, face_engine, face_quality, face_review, face_scan, ffmpeg, files, highlights, libraries, library, people, photo_meta, scan};
use serde::de::DeserializeOwned;
use serde_json::Value as JsonValue;
use std::future::Future;
use std::pin::Pin;

type CallFuture = Pin<Box<dyn Future<Output = Result<(JsonValue, Changed), ApiError>> + Send>>;

pub struct Command {
    pub name: &'static str,
    pub role: Role,
    call: fn(Arc<ServerHost>, Arc<Scope>, JsonValue) -> CallFuture,
}

// What an editing command changed, for the `changes` table and the events other users' clients refresh from
#[derive(Default, Debug)]
pub struct Changed {
    pub photos: Vec<String>,
    pub people: bool,
    pub albums: bool,
    // Users whose view changed because an album was shared with them or no longer is
    pub shared_with: Vec<String>,
    // Users whose roles changed (or who were removed)
    pub roles_of: Vec<String>,
}

impl Changed {
    fn photos(hashes: impl IntoIterator<Item = String>) -> Changed {
        Changed { photos: hashes.into_iter().collect(), ..Default::default() }
    }
    fn people() -> Changed {
        Changed { people: true, ..Default::default() }
    }
    fn albums() -> Changed {
        Changed { albums: true, ..Default::default() }
    }
    fn and_people(mut self) -> Changed {
        self.people = true;
        self
    }
    fn and_albums(mut self) -> Changed {
        self.albums = true;
        self
    }
    pub fn is_empty(&self) -> bool {
        self.photos.is_empty() && !self.people && !self.albums && self.shared_with.is_empty() && self.roles_of.is_empty()
    }
}

fn parse_args<T: DeserializeOwned>(args: JsonValue) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad arguments: {e}")))
}

fn answer<T: serde::Serialize, E: Into<ApiError>>(result: Result<T, E>) -> Result<JsonValue, ApiError> {
    let value = result.map_err(Into::into)?;
    serde_json::to_value(value).map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// Checks the command's target against the caller's scope, on a blocking thread (it reads the database)
async fn check(host: &Arc<ServerHost>, scope: &Arc<Scope>, role: Role, target: Option<Target>) -> Result<(), ApiError> {
    let target = match target {
        Some(t) => t,
        None if role == Role::Admin => Target::Server,
        None if role >= Role::Editor => Target::AnyLibrary,
        // Reading: the command filters its own results
        None => return Ok(()),
    };
    let (host, scope) = (host.clone(), scope.clone());
    tokio::task::spawn_blocking(move || {
        let conn = db::open_global_db(&*host)?;
        access::authorize(&conn, &scope, role, target)
    })
    .await
    .map_err(|e| ApiError::from(e.to_string()))?
}

// One line per command:
//   ROLE [[TARGET]] async|blocking NAME(arg: Type, ...) |host, scope| expression giving Result<T, String or ApiError>
//        [=> before|after expression giving Result<Changed, String>];
// The role is checked against TARGET (what the command touches, from its arguments; see access.rs), on the
// caller's role for each library involved. Without a target an editor command needs the role on some
// library, an admin command is admin work, and a viewer command filters its own results by `scope`.
// `async` expressions may .await; `blocking` ones run on a blocking thread (SQLite, files). Argument names
// are the Rust ones; the client sends them in camelCase, as to Tauri. The optional effect says what the
// command changed; it sees the same arguments and runs on a blocking thread, before the command (when the
// command removes what the effect looks up) or after it.
macro_rules! commands {
    ($( $role:ident $([ $target:expr ])? $kind:ident $name:ident ( $($arg:ident : $ty:ty),* $(,)? ) |$host:ident, $scope:ident| $body:expr $( => $when:ident $effect:expr )? ; )*) => {
        pub static COMMANDS: &[Command] = &[
            $( Command {
                name: stringify!($name),
                role: Role::$role,
                call: |$host, $scope, args| Box::pin(async move {
                    #[derive(serde::Deserialize)]
                    #[serde(rename_all = "camelCase")]
                    struct Args { $( $arg: $ty ),* }
                    #[allow(unused_variables)]
                    let (effect_host, effect_args) = ($host.clone(), args.clone());
                    #[allow(unused_mut, unused_assignments)]
                    let mut changed = Changed::default();
                    #[allow(unused_variables)]
                    let Args { $( $arg ),* } = parse_args::<Args>(args)?;
                    let target: Option<Target> = commands!(@target $($target)?);
                    check(&$host, &$scope, Role::$role, target).await?;
                    commands!(@effect before, changed, effect_host, effect_args, $host, [$($arg),*] $(, $when $effect)?);
                    #[allow(unused_variables)]
                    let $scope = $scope.clone();
                    let value = commands!(@run $kind $body)?;
                    commands!(@effect after, changed, effect_host, effect_args, $host, [$($arg),*] $(, $when $effect)?);
                    Ok((value, changed))
                }),
            } ),*
        ];
    };
    (@target) => { None };
    (@target $target:expr) => { Some($target) };
    (@effect before, $c:ident, $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*], before $effect:expr) => {
        $c = commands!(@compute $eh, $ej, $host, [$($arg),*], $effect);
    };
    (@effect after, $c:ident, $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*], after $effect:expr) => {
        $c = commands!(@compute $eh, $ej, $host, [$($arg),*], $effect);
    };
    (@effect $at:ident, $c:ident, $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*] $(, $when:ident $effect:expr)?) => {};
    (@compute $eh:ident, $ej:ident, $host:ident, [$($arg:ident),*], $effect:expr) => {{
        #[allow(unused_variables)]
        let $host = $eh.clone();
        let json = $ej.clone();
        match tokio::task::spawn_blocking(move || -> Result<Changed, ApiError> {
            #[allow(unused_variables)]
            let Args { $( $arg ),* } = parse_args::<Args>(json)?;
            let effect: Result<Changed, String> = $effect;
            effect.map_err(ApiError::from)
        })
        .await
        {
            Ok(result) => result?,
            Err(e) => return Err(ApiError::from(e.to_string())),
        }
    }};
    (@run async $body:expr) => { answer($body) };
    (@run blocking $body:expr) => {
        match tokio::task::spawn_blocking(move || $body).await {
            Ok(result) => answer(result),
            Err(e) => Err(ApiError::from(e.to_string())),
        }
    };
}

// The photos that hold these faces (looked up before a command that may remove them)
fn photos_of_faces(host: &ServerHost, face_ids: &[String]) -> Result<Vec<String>, String> {
    let conn = db::open_global_db(host)?;
    access::photos_of_faces(&conn, face_ids).map_err(|e| e.1)
}

// Every photo with this person on it (after a change that can reach far beyond the photos it names:
// a rename, a merge)
fn photos_of_person(host: &ServerHost, name: &str) -> Result<Changed, String> {
    let conn = db::open_global_db(host)?;
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT hash FROM photo_people WHERE lower(person_name) = lower(?1)
             UNION SELECT DISTINCT hash FROM photo_faces WHERE lower(person_name) = lower(?1)",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([name.trim()], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(Changed::photos(rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?).and_people())
}

fn staged_photos(host: &Arc<ServerHost>, root_folder: Option<String>) -> Result<Changed, String> {
    Ok(Changed::photos(library::get_staged_operations(host.clone(), root_folder)?.into_iter().map(|op| op.hash)))
}

// An optional library root from a client: one of the server's libraries, or none (all of them)
fn optional_root(host: &ServerHost, root: Option<String>) -> Result<Option<String>, ApiError> {
    root.map(|r| lookup::library_root(host, &r)).transpose()
}

// A read command's answer, kept to what this user may see (see access.rs)
fn visible_only<T: serde::Serialize>(host: &ServerHost, scope: &Scope, result: Result<T, String>) -> Result<JsonValue, ApiError> {
    let value = answer(result)?;
    if scope.sees_all() {
        return Ok(value);
    }
    access::keep_visible(&db::open_global_db(host)?, scope, value)
}

// The libraries this user sees anything of, with their role on each (a guest's counts are of what is shared)
fn libraries_for(host: &ServerHost, scope: &Scope) -> Result<JsonValue, ApiError> {
    let conn = db::open_global_db(host)?;
    let mut out = Vec::new();
    for l in libraries::list(&conn)? {
        let role = scope.role_on(l.id);
        let present = libraries::present_photos(&conn, l.id)?;
        let photos = if role >= Role::Viewer {
            present.len()
        } else {
            let visible = access::visible_photos(&conn, scope, Some(l.id))?;
            present.iter().filter(|h| visible.contains(*h)).count()
        };
        if role >= Role::Viewer || photos > 0 {
            out.push(serde_json::json!({ "id": l.id, "root": l.root, "name": l.name, "photos": photos, "role": role.as_str() }));
        }
    }
    Ok(JsonValue::Array(out))
}

fn people_for(host: &ServerHost, scope: &Scope, root: Option<String>, people: Vec<PersonItem>) -> Result<JsonValue, ApiError> {
    let value = answer(Ok::<_, String>(people))?;
    let library = root.as_deref().and_then(|r| scope.library_id_of_root(r));
    let sees = match library {
        Some(id) => scope.role_on(id) >= Role::Viewer,
        None => scope.sees_all(),
    };
    if sees {
        return Ok(value);
    }
    access::people_for(&db::open_global_db(host)?, scope, library, value)
}

// Of a backup's values, those this user may set: on any photo of a library where they are an editor, else
// on their own uploads (their uploads/<name>/ folder); answers those and the hashes of the others
fn values_allowed(host: &ServerHost, scope: &Scope, items: Vec<lumina_core::photo_meta::PhotoMeta>) -> Result<(Vec<lumina_core::photo_meta::PhotoMeta>, Vec<String>), String> {
    let conn = db::open_global_db(host)?;
    let own = format!("uploads/{}/", super::upload::safe_name(&scope.user.name, "user"));
    let (mut allowed, mut not_yours) = (Vec::new(), Vec::new());
    for m in items {
        let place = conn
            .query_row("SELECT library_id, rel_path FROM photos WHERE hash = ?1", [&m.hash], |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?)))
            .ok();
        let may = match place {
            // Not there: apply reports it as missing
            None => true,
            Some((library, rel_path)) => {
                scope.admin() || library.is_some_and(|l| scope.role_on(l) >= Role::Editor) || rel_path.is_some_and(|r| r.starts_with(&own))
            }
        };
        if may {
            allowed.push(m);
        } else {
            not_yours.push(m.hash);
        }
    }
    Ok((allowed, not_yours))
}

// A user to share with, by name
fn user_id(host: &ServerHost, name: &str) -> Result<i64, ApiError> {
    let conn = db::open_global_db(host)?;
    accounts::find_user(&conn, name)?.map(|u| u.id).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "No such user"))
}

commands! {
    // Browsing (viewer and up; a guest sees what is shared with them). scan_folder lists a library from the
    // database: the server keeps its libraries up to date itself; a rescan is admin work (rescan_library).
    Viewer [Target::Root(folder_path.clone())] async scan_folder(folder_path: String, force_reprocess: Option<bool>) |host, scope| {
        let _ = force_reprocess;
        let root = lookup::library_root(&*host, &folder_path)?;
        let photos = scan::list_library(host.clone(), root).await;
        visible_only(&host, &scope, photos)
    };
    Viewer blocking list_libraries() |host, scope| libraries_for(&host, &scope);
    // Photos another user changed, to refresh just those
    Viewer blocking get_photos(hashes: Vec<String>) |host, scope| {
        let wanted = scope.visible(&db::open_global_db(&*host)?, &hashes)?;
        scan::photos_by_hash(&*host, &wanted).map_err(ApiError::from)
    };
    Viewer [Target::Photos(vec![hash.clone()])] blocking get_photo_history(hash: String) |host, scope|
        changes::history(&db::open_global_db(&*host)?, &hash, 50);
    // The server watches its libraries by itself
    // Which of these photos the server has (and this user may see): for a client's "on this device" check
    Viewer blocking content_hashes(hashes: Vec<String>) |host, scope| scope.visible(&db::open_global_db(&*host)?, &hashes);
    Viewer blocking watch_library(root: Option<String>) |host, scope| { let _ = (host, root); Ok::<(), String>(()) };
    Viewer [Target::OptRoot(root_folder.clone())] async get_people(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        let people = people::get_people(host.clone(), root.clone()).await?;
        people_for(&host, &scope, root, people)
    };
    Viewer blocking get_albums() |host, scope| {
        let all = answer(albums::get_albums(host.clone()))?;
        access::albums_for(&db::open_global_db(&*host)?, &scope, all)
    };
    // Saved searches and trip names say something about the whole library: not for someone who sees only
    // what is shared with them
    Viewer blocking get_saved_searches() |host, scope| {
        if scope.admin() || scope.anywhere(Role::Viewer) { albums::get_saved_searches(host) } else { Ok(Vec::new()) }
    };
    Viewer blocking get_trip_names() |host, scope| {
        if scope.admin() || scope.anywhere(Role::Viewer) { albums::get_trip_names(host) } else { Ok(Default::default()) }
    };
    Viewer [Target::OptRoot(root_folder.clone())] async semantic_status(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        clip::semantic_status(host, root).await.map_err(ApiError::from)
    };
    Viewer async semantic_search(query: String) |host, scope| {
        let hits = clip::semantic_search(host.clone(), query).await;
        visible_only(&host, &scope, hits)
    };
    Viewer [Target::Photos(vec![hash.clone()])] async find_similar_photos(hash: String) |host, scope| {
        let hits = clip::find_similar_photos(host.clone(), hash).await;
        visible_only(&host, &scope, hits)
    };
    Viewer blocking search_cities_offline(query: String) |host, scope| { let _ = host; library::search_cities_offline(query) };
    Viewer blocking get_face_match_config() |host, scope| { let _ = host; Ok::<_, String>(face_engine::get_face_match_config()) };
    Viewer async get_confirmed_faces_for_person(person_name: String) |host, scope| {
        let faces = face_review::get_confirmed_faces_for_person(host.clone(), person_name).await;
        visible_only(&host, &scope, faces)
    };
    Viewer [Target::Photos(candidates.iter().map(|c| c.hash.clone()).collect())] async pick_highlights(candidates: Vec<highlights::HighlightCandidate>, count: usize) |host, scope|
        highlights::pick_highlights(host, candidates, count).await;
    Viewer [Target::Photos(vec![hash.clone()])] blocking existing_playable_copy(hash: String) |host, scope|
        Ok::<_, String>(ffmpeg::existing_playable_copy(host, hash));
    Viewer [Target::Photos(vec![hash.clone()])] async make_playable_copy(hash: String) |host, scope| ffmpeg::make_playable_copy(host, hash).await;
    Viewer blocking cancel_playable_copy() |host, scope| { let _ = host; ffmpeg::cancel_playable_copy(); Ok::<(), String>(()) };
    Viewer [Target::Photos(vec![hash.clone()])] blocking ensure_high_res_preview(hash: String, source_path: String) |host, scope| {
        lookup::check_photo_path(&*host, &hash, &source_path)?;
        decode::ensure_high_res_preview(&*host, &hash, &source_path).map_err(ApiError::from)
    };
    Viewer async check_ollama_status() |host, scope| { let _ = host; ai::check_ollama_status().await };

    // Editing photos (editor and up, on the library of each photo)
    Editor [Target::Photos(hashes.clone())] blocking set_photos_rating(hashes: Vec<String>, rating: i32) |host, scope|
        library::set_photos_rating(host, hashes, rating)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(hashes.clone())] blocking set_photo_flag(hashes: Vec<String>, flag: Option<String>) |host, scope|
        library::set_photo_flag(host, hashes, flag)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(hashes.clone())] blocking set_photo_color_label(hashes: Vec<String>, color: Option<String>) |host, scope|
        library::set_photo_color_label(host, hashes, color)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(hashes.clone())] blocking set_photo_rotation(hashes: Vec<String>, delta_degrees: i32) |host, scope|
        library::set_photo_rotation(host, hashes, delta_degrees)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(ops.iter().map(|o| o.hash.clone()).collect())] blocking set_photos_rotation_exact(ops: Vec<library::RotationResetInput>) |host, scope|
        library::set_photos_rotation_exact(host, ops)
        => after Ok(Changed::photos(ops.into_iter().map(|o| o.hash)));
    Editor [Target::Photos(hashes.clone())] blocking add_tag_batch(hashes: Vec<String>, tag: String) |host, scope|
        library::add_tag_batch(host, hashes, tag)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(vec![hash.clone()])] blocking remove_tag(hash: String, tag: String) |host, scope| library::remove_tag(host, hash, tag)
        => after Ok(Changed::photos([hash]));
    Editor [Target::Photos(hashes.clone())] blocking remove_tag_batch(hashes: Vec<String>, tag: String) |host, scope|
        library::remove_tag_batch(host, hashes, tag)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(hashes.clone())] blocking set_manual_location(hashes: Vec<String>, location: String, latitude: Option<f64>, longitude: Option<f64>) |host, scope|
        library::set_manual_location(host, hashes, location, latitude, longitude)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(hashes.clone())] blocking shift_capture_timestamps(hashes: Vec<String>, offset_minutes: i64) |host, scope|
        library::shift_capture_timestamps(host, hashes, offset_minutes)
        => after Ok(Changed::photos(hashes));
    Editor [Target::Photos(hashes.clone())] async rescan_exif_batch(hashes: Vec<String>) |host, scope| scan::rescan_exif_batch(host, hashes).await
        => after Ok(Changed::photos(hashes));

    // People and faces (a person spans libraries: changing one needs the role wherever they are)
    Editor [Target::Photos(hashes.clone())] blocking add_person_to_photos(hashes: Vec<String>, name: String) |host, scope|
        people::add_person_to_photos(host, hashes, name)
        => after Ok(Changed::photos(hashes).and_people());
    Editor [Target::Photos(vec![hash.clone()])] blocking remove_person_from_photo(hash: String, name: String) |host, scope|
        people::remove_person_from_photo(host, hash, name)
        => after Ok(Changed::photos([hash]).and_people());
    Editor [Target::Photos(hashes.clone())] blocking remove_person_from_photos(hashes: Vec<String>, name: String) |host, scope|
        people::remove_person_from_photos(host, hashes, name)
        => after Ok(Changed::photos(hashes).and_people());
    Editor [Target::Person(old_name.clone())] async rename_person(old_name: String, new_name: String) |host, scope|
        people::rename_person(host, old_name, new_name).await
        => after photos_of_person(&host, &new_name);
    Editor [Target::Person(name.clone())] blocking set_person_hidden(name: String, hidden: bool) |host, scope|
        people::set_person_hidden(host, name, hidden)
        => after Ok(Changed::people());
    Editor [Target::Person(name.clone())] blocking set_person_starred(name: String, starred: bool) |host, scope|
        people::set_person_starred(host, name, starred)
        => after Ok(Changed::people());
    Editor [Target::Faces(vec![face_id.clone()])] blocking set_person_cover(name: String, face_id: String) |host, scope|
        people::set_person_cover(host, name, face_id)
        => after Ok(Changed::people());
    Editor [Target::OptRoot(root_folder.clone())] async find_similar_faces(person_name: String, root_folder: Option<String>, force_refresh: Option<bool>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        let faces = face_review::find_similar_faces(host.clone(), person_name, root, force_refresh).await;
        visible_only(&host, &scope, faces)
    };
    Editor [Target::Person(person_name.clone())] async get_rejected_faces_for_person(person_name: String) |host, scope| {
        let faces = face_review::get_rejected_faces_for_person(host.clone(), person_name).await;
        visible_only(&host, &scope, faces)
    };
    Editor [Target::Faces(face_ids.clone())] async assign_faces_to_person_batch(face_ids: Vec<String>, person_name: String) |host, scope|
        face_review::assign_faces_to_person_batch(host, face_ids, person_name).await
        => after Ok(Changed::photos(photos_of_faces(&host, &face_ids)?).and_people());
    Editor [Target::Faces(face_ids.clone())] async unassign_faces_batch(face_ids: Vec<String>, person_name: String) |host, scope|
        face_review::unassign_faces_batch(host, face_ids, person_name).await
        => after Ok(Changed::photos(photos_of_faces(&host, &face_ids)?).and_people());
    Editor [Target::Faces(face_ids.clone())] async reject_face_candidates_batch(face_ids: Vec<String>, person_name: String) |host, scope|
        face_review::reject_face_candidates_batch(host, face_ids, person_name).await
        => after Ok(Changed::people());
    Editor [Target::Faces(face_ids.clone())] async unreject_face_candidates_batch(face_ids: Vec<String>, person_name: String) |host, scope|
        face_review::unreject_face_candidates_batch(host, face_ids, person_name).await
        => after Ok(Changed::people());
    Editor [Target::Faces(face_ids.clone())] async ignore_faces(face_ids: Vec<String>, ignore: bool) |host, scope|
        face_review::ignore_faces(host, face_ids, ignore).await
        => before Ok(Changed::photos(photos_of_faces(&host, &face_ids)?).and_people());
    Editor [Target::OptRoot(root_folder.clone())] async get_pending_face_match_counts(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        face_review::get_pending_face_match_counts(host, root).await.map_err(ApiError::from)
    };
    Editor [Target::OptRoot(root_folder.clone())] async get_unknown_face_clusters(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        face_review::get_unknown_face_clusters(host, root).await.map_err(ApiError::from)
    };
    Editor [Target::Photos(vec![hash.clone()])] async assign_face_region_and_automatch(hash: String, image_path: String, bbox_x: f64, bbox_y: f64, bbox_w: f64, bbox_h: f64, person_name: String) |host, scope| {
        lookup::check_photo_path(&*host, &hash, &image_path)?;
        face_review::assign_face_region_and_automatch(host, hash, image_path, bbox_x, bbox_y, bbox_w, bbox_h, person_name)
            .await
            .map_err(ApiError::from)
    }
        => after photos_of_person(&host, &person_name).map(|c| Changed::photos(c.photos.into_iter().chain([hash])).and_people());
    Editor [Target::Photos(vec![hash.clone()])] blocking remove_face_box(face_id: String, hash: String) |host, scope|
        face_review::remove_face_box(host, face_id, hash)
        => after Ok(Changed::photos([hash]).and_people());
    Editor [Target::Photos(vec![hash.clone()])] async detect_faces_in_photo(hash: String, image_path: String, force_onnx: Option<bool>) |host, scope| {
        lookup::check_photo_path(&*host, &hash, &image_path)?;
        face_scan::detect_faces_in_photo(host, hash, image_path, force_onnx).await.map_err(ApiError::from)
    }
        => after Ok(Changed::photos([hash]).and_people());
    Editor [Target::OptRoot(root_folder.clone())] async get_outdated_face_photos(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        face_scan::get_outdated_face_photos(host, root).await.map_err(ApiError::from)
    };

    // Each person's face in short (All photos suggests people of two libraries are one); a guest's of the
    // faces in what is shared with them
    Viewer blocking person_centroids() |host, scope| {
        let conn = db::open_global_db(&*host).map_err(ApiError::from)?;
        let visible = if scope.sees_all() { None } else { Some(access::visible_photos(&conn, &scope, None)?) };
        face_review::person_centroids(&conn, visible.as_ref()).map_err(ApiError::from)
    };
    // Names of your own for people (docs/plans/one-view.md, People): each user's own, any role, guests too;
    // the people themselves don't change, so nobody else is told
    Viewer blocking get_person_names() |host, scope| {
        let conn = db::open_global_db(&*host)?;
        crate::person_names::of_user(&conn, scope.user.id)
    };
    Viewer blocking set_person_name(person: String, shown_as: Option<String>, apart: Option<bool>) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        crate::person_names::set(&conn, scope.user.id, &person, shown_as.as_deref(), apart.unwrap_or(false))
    };

    // Following a shared album (docs/plans/one-view.md): what travels with its photos to the follower's own
    // library, their tags and people names (as this user calls them); ratings, flags, labels, captions and
    // albums stay the sharer's
    Viewer [Target::Photos(hashes.clone())] blocking photo_values(hashes: Vec<String>) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        let own: std::collections::HashMap<String, String> = crate::person_names::of_user(&conn, scope.user.id)?
            .into_iter()
            .filter_map(|n| Some((n.person.to_lowercase(), n.shown_as?)))
            .collect();
        let named = |name: &str| own.get(&name.to_lowercase()).cloned().unwrap_or_else(|| name.to_string());
        let values: Vec<photo_meta::PhotoMeta> = photo_meta::collect(&conn, &hashes)?
            .into_iter()
            .map(|m| photo_meta::PhotoMeta {
                hash: m.hash,
                tags: m.tags,
                people: m.people.iter().map(|p| named(p)).collect(),
                faces: m.faces.into_iter().map(|f| photo_meta::NamedFace { name: named(&f.name), ..f }).collect(),
                ..Default::default()
            })
            .collect();
        Ok::<_, String>(values)
    };

    // Backup (docs/plans/one-view.md): the values a device had for photos it uploaded, put on where the
    // server's copy has none (names on faces the server finds there, also later). An uploader's go on the
    // photos they uploaded themselves; other photos need an editor.
    Uploader [Target::Photos(items.iter().map(|m| m.hash.clone()).collect())] blocking apply_backup_values(items: Vec<photo_meta::PhotoMeta>) |host, scope| {
        let (allowed, not_yours) = values_allowed(&host, &scope, items)?;
        let mut report = photo_meta::apply(&mut db::open_global_db(&*host)?, &allowed)?;
        report.not_yours = not_yours;
        Ok::<_, String>(report)
    }
        => after {
            let mut changed = Changed::photos(items.iter().map(|m| m.hash.clone()));
            changed.people = items.iter().any(|m| !m.faces.is_empty() || !m.people.is_empty());
            changed.albums = items.iter().any(|m| !m.albums.is_empty());
            Ok(changed)
        };

    // Albums, saved searches and trips. An album may hold photos of several libraries: changing it needs
    // the role on each of them
    Editor blocking create_album(name: String) |host, scope| albums::create_album(host, name) => after Ok(Changed::albums());
    Editor [Target::Album(id)] blocking rename_album(id: i64, name: String) |host, scope| albums::rename_album(host, id, name)
        => after Ok(Changed::albums());
    Editor [Target::Album(id)] blocking delete_album(id: i64) |host, scope| albums::delete_album(host, id) => after Ok(Changed::albums());
    Editor [Target::Photos(hashes.clone())] blocking add_to_album(id: i64, hashes: Vec<String>) |host, scope| albums::add_to_album(host, id, hashes)
        => after Ok(Changed::photos(hashes).and_albums());
    Editor [Target::Photos(hashes.clone())] blocking remove_from_album(id: i64, hashes: Vec<String>) |host, scope| albums::remove_from_album(host, id, hashes)
        => after Ok(Changed::photos(hashes).and_albums());
    Editor blocking save_search(name: String, query: String, smart: Option<bool>) |host, scope| albums::save_search(host, name, query, smart.unwrap_or(false)) => after Ok(Changed::albums());
    // Whoever it was shared with loses it at once
    Editor blocking delete_saved_search(id: i64) |host, scope| {
        dynamic::forget_search(&db::open_global_db(&*host)?, id)?;
        albums::delete_saved_search(host, id)
    }
        => before Ok(Changed { shared_with: dynamic::shares_of(&db::open_global_db(&*host)?, id)?, albums: true, ..Default::default() });
    Editor blocking set_trip_name(trip_id: String, name: String) |host, scope| albums::set_trip_name(host, trip_id, name)
        => after Ok(Changed::albums());
    // Sharing an album with someone who may see only that (a guest), or with anyone else
    Editor [Target::Album(id)] blocking get_album_shares(id: i64) |host, scope| scope::album_shares(&db::open_global_db(&*host)?, id);
    Editor [Target::Album(id)] blocking share_album(id: i64, user_name: String, shared: bool) |host, scope| {
        let user = user_id(&host, &user_name)?;
        scope::share_album(&db::open_global_db(&*host)?, id, user, shared).map_err(ApiError::from)
    }
        => after Ok(Changed { shared_with: vec![user_name], albums: true, ..Default::default() });
    // Sharing a dynamic album (a saved search): it runs over the libraries the person sharing it may edit, and
    // whoever it is shared with sees its photos as an album, not its query (dynamic.rs)
    Editor blocking get_search_shares(id: i64) |host, scope| dynamic::shares_of(&db::open_global_db(&*host)?, id);
    Editor async share_search(id: i64, user_name: String, shared: bool) |host, scope| {
        let user = user_id(&host, &user_name)?;
        dynamic::share(&db::open_global_db(&*host)?, id, user, scope.user.id, shared)?;
        dynamic::refresh(&host).await.map(|_| ())
    }
        => after Ok(Changed { shared_with: vec![user_name], albums: true, ..Default::default() });
    // Who an album can be shared with: every account's name and default role
    Editor blocking list_share_users() |host, scope| {
        let conn = db::open_global_db(&*host)?;
        let users = accounts::list_users(&conn)?;
        Ok::<_, String>(users.into_iter().filter(|u| u.id != scope.user.id).collect::<Vec<_>>())
    };

    // AI on single photos (a batch is admin work; while one runs, these answer "Batch AI is running")
    Editor [Target::Photos(vec![hash.clone()])] async ai_analyze_photo(hash: String, image_path_for_ai: String, model_name: String, existing_tags: Vec<String>) |host, scope| {
        lookup::check_photo_path(&*host, &hash, &image_path_for_ai)?;
        ai::ai_analyze_photo(host, hash, image_path_for_ai, model_name, existing_tags).await.map_err(ApiError::from)
    }
        => after Ok(Changed::photos([hash]));
    Editor [Target::Photos(vec![hash.clone()])] async prepare_ai_image(hash: String, image_path: String) |host, scope| {
        lookup::check_photo_path(&*host, &hash, &image_path)?;
        ai::prepare_ai_image(host, hash, image_path).await.map_err(ApiError::from)
    };
    Editor blocking cancel_ai_analysis() |host, scope| { let _ = host; ai::cancel_ai_analysis(); Ok::<(), String>(()) };

    // Duplicates and planned moves: only marked here; files change at commit_staged_operations (admin)
    Editor [Target::OptRoot(root_folder.clone())] async find_duplicates(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        duplicates::find_duplicates(host, root).await.map_err(ApiError::from)
    };
    Editor [Target::Photos(sets.iter().flat_map(|s| std::iter::once(s.keep.clone()).chain(s.extras.clone())).collect())] async stage_duplicate_extras(sets: Vec<duplicates::DuplicateStageInput>) |host, scope|
        duplicates::stage_duplicate_extras(host, sets).await
        => after Ok(Changed::photos(sets.into_iter().flat_map(|s| std::iter::once(s.keep).chain(s.extras))).and_albums().and_people());
    Editor [Target::Photos(vec![hash.clone()])] blocking stage_photo_move(hash: String, target_subfolder: Option<String>) |host, scope|
        library::stage_photo_move(host, hash, target_subfolder)
        => after Ok(Changed::photos([hash]));
    Editor [Target::Photos(ops.iter().map(|o| o.hash.clone()).collect())] blocking stage_photos_move(ops: Vec<library::StagedMoveInput>) |host, scope|
        library::stage_photos_move(host, ops)
        => after Ok(Changed::photos(ops.into_iter().map(|o| o.hash)));
    Editor [Target::OptRoot(root_folder.clone())] blocking get_staged_operations(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        library::get_staged_operations(host, root).map_err(ApiError::from)
    };

    // Administration: files on disk, caches, and the long jobs (their cancel flags are process-wide)
    Admin async commit_staged_operations(root_folder: String, smart_rename: Option<bool>) |host, scope| {
        let root = lookup::library_root(&*host, &root_folder)?;
        files::commit_staged_operations(host, root, smart_rename).await.map_err(ApiError::from)
    }
        => before staged_photos(&host, Some(root_folder));
    Admin blocking clear_all_staged(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        library::clear_all_staged(host, root).map_err(ApiError::from)
    }
        => before staged_photos(&host, root_folder);
    Admin async trash_summary(root_folder: String) |host, scope| {
        let root = lookup::library_root(&*host, &root_folder)?;
        files::trash_summary(host, root).await.map_err(ApiError::from)
    };
    // The server has no Recycle Bin: emptying _Trash always deletes for good (the client asks first)
    Admin async empty_library_trash_to_os(root_folder: String, permanent: Option<bool>) |host, scope| {
        let _ = permanent;
        let root = lookup::library_root(&*host, &root_folder)?;
        files::empty_library_trash_to_os(host, root, Some(true)).await.map_err(ApiError::from)
    };
    Admin async export_xmp_sidecars(hashes: Option<Vec<String>>, root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        files::export_xmp_sidecars(host, hashes, root).await.map_err(ApiError::from)
    };
    Admin async get_library_health_stats(root_folder: Option<String>) |host, scope| {
        let root = optional_root(&host, root_folder)?;
        files::get_library_health_stats(host, root).await.map_err(ApiError::from)
    };
    Admin async prune_orphaned_cache() |host, scope| files::prune_orphaned_cache(host).await;
    Admin [Target::Root(root_folder.clone())] async forget_missing_files(root_folder: String) |host, scope| {
        let root = lookup::library_root(&host, &root_folder)?;
        files::forget_missing_files(host, root).await.map_err(ApiError::from)
    } => after Ok(Changed { people: true, albums: true, ..Default::default() });
    Admin blocking video_cache_info() |host, scope| Ok::<_, String>(ffmpeg::video_cache_info(host));
    Admin blocking clear_video_cache() |host, scope| Ok::<_, String>(ffmpeg::clear_video_cache(host));
    // A rescan walks the library's folders (the listing above doesn't)
    Admin async rescan_library(folder_path: String) |host, scope| {
        let root = lookup::library_root(&*host, &folder_path)?;
        scan::scan_folder(host, root, Some(false)).await.map_err(ApiError::from)
    };
    Admin blocking cancel_folder_scan() |host, scope| { let _ = host; scan::cancel_folder_scan(); Ok::<(), String>(()) };
    Admin blocking cancel_thumbnail_pass() |host, scope| { let _ = host; scan::cancel_thumbnail_pass(); Ok::<(), String>(()) };
    Admin async scan_library_faces_batch(hashes: Vec<String>) |host, scope| face_scan::scan_library_faces_batch(host, hashes).await;
    Admin blocking cancel_face_scan() |host, scope| { let _ = host; face_scan::cancel_face_scan(); Ok::<(), String>(()) };
    Admin async measure_face_quality(root_folder: String) |host, scope| {
        let root = lookup::library_root(&*host, &root_folder)?;
        face_quality::measure_face_quality(host, root).await.map_err(ApiError::from)
    };
    Admin async start_semantic_index(root_folder: String) |host, scope| {
        let root = lookup::library_root(&*host, &root_folder)?;
        clip::start_semantic_index(host, root).await.map_err(ApiError::from)
    };
    Admin blocking cancel_semantic_index() |host, scope| { let _ = host; clip::cancel_semantic_index(); Ok::<(), String>(()) };
    Admin async run_caption_batch(hashes: Vec<String>, model_name: String) |host, scope| ai::run_caption_batch(host, hashes, model_name).await;
    Admin async ollama_tuning_status() |host, scope| { let _ = host; Ok::<_, String>(ai::ollama_tuning_status().await) };
    Admin async preload_ollama_vram(model_name: String) |host, scope| { let _ = host; ai::preload_ollama_vram(model_name).await };
    Admin async unload_ollama_vram(model_name: String) |host, scope| { let _ = host; ai::unload_ollama_vram(model_name).await };
    Admin async pull_ollama_model(model_name: String) |host, scope| ai::pull_ollama_model(host, model_name).await;
    Admin blocking cancel_ollama_pull() |host, scope| { let _ = host; ai::cancel_ollama_pull(); Ok::<(), String>(()) };
    // The admin page: the server's state, jobs for a library, accounts, restoring a backup
    Admin async server_status() |host, scope| admin::status(&host).await;
    Admin blocking start_library_job(root_folder: String, job: String) |host, scope| {
        let root = lookup::library_root(&*host, &root_folder)?;
        let job = Job::parse(&job, root)?;
        host.jobs.queue(job).map_err(ApiError::from)
    };
    Admin blocking admin_list_users() |host, scope| admin::accounts(&host);
    Admin blocking admin_create_user(name: String, role: String, password: String) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        let role = Role::parse(&role)?;
        accounts::create_user(&conn, &name, role, &password).map(|u| u.name).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
    };
    Admin blocking admin_set_role(name: String, role: String) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        let role = Role::parse(&role).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
        admin::check_not_last_admin(&conn, &scope.user, &name, role != Role::Admin)?;
        accounts::set_role(&conn, &name, role).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
    }
        => after Ok(Changed { roles_of: vec![name], ..Default::default() });
    // A role on one library (None: back to their default)
    Admin blocking admin_set_library_role(name: String, root_folder: String, role: Option<String>) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        let user = accounts::find_user(&conn, &name)?.ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "No such user"))?;
        let library = scope.library_id_of_root(&root_folder).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Not a library on this server"))?;
        let role = role.map(|r| Role::parse(&r)).transpose().map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
        scope::set_library_role(&conn, user.id, library, role).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
    }
        => after Ok(Changed { roles_of: vec![name], ..Default::default() });
    Admin blocking admin_set_password(name: String, password: String) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        accounts::set_password(&conn, &name, &password).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
    };
    Admin blocking admin_remove_user(name: String) |host, scope| {
        let conn = db::open_global_db(&*host)?;
        admin::check_not_last_admin(&conn, &scope.user, &name, true)?;
        accounts::remove_user(&conn, &name).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))
    }
        => after Ok(Changed { roles_of: vec![name], ..Default::default() });
    // A backup the admin page uploaded (POST /api/admin/restore), by the name the upload answered
    Admin async inspect_backup(path: String) |host, scope| {
        let file = restore::uploaded(&host, &path)?;
        backup::inspect_backup(file.to_string_lossy().to_string()).await.map_err(ApiError::from)
    };
    // Stages the backup's database (with folders moved to the server's), then the server starts again and
    // moves it in, keeping its accounts
    Admin async restore_library(path: String, remaps: Vec<backup::RootRemap>) |host, scope| {
        let file = restore::uploaded(&host, &path)?;
        let result = backup::restore_library(host.clone(), file.to_string_lossy().to_string(), remaps).await?;
        println!("[restore] {} restored a backup: {} photos; starting again", scope.user.name, result.photos);
        tokio::spawn(async {
            // Time for this answer to reach the browser
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
            restore::restart();
        });
        Ok::<_, ApiError>(result)
    };
}

// Desktop commands that have no place on a server: they act on the computer the app runs [open a file,
// the clipboard, a card reader, a local Ollama] or write to its folders. Downloads and uploads replace some
// of them in phase 3.
pub const NOT_ON_SERVER: &[&str] = &[
    "open_in_default_app",
    "reveal_in_file_manager",
    "create_library_subfolder",
    "get_app_data_dir",
    "copy_image_to_clipboard",
    "close_splashscreen",
    "restart_app",
    "list_import_sources",
    "preview_import",
    "start_import",
    "cancel_import",
    "export_photos",
    "cancel_export",
    "export_gallery",
    "backup_library",
    "export_library_csv",
    "start_ollama_service",
    "enable_ollama_flash_attention",
    // The basket belongs to each device (the window keeps it), not to a server's library
    "set_photo_basket",
];

pub fn lookup(name: &str) -> Option<&'static Command> {
    COMMANDS.iter().find(|c| c.name == name)
}

pub async fn call(
    State(state): State<Shared>,
    Extension(user): Extension<User>,
    Path(command): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<JsonValue>, ApiError> {
    if NOT_ON_SERVER.contains(&command.as_str()) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, format!("{command} isn't available on the server")));
    }
    let cmd = lookup(&command).ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Unknown command: {command}")))?;
    let host = state.host.clone();
    let scope = {
        let (host, user) = (host.clone(), user.clone());
        tokio::task::spawn_blocking(move || Scope::load(&db::open_global_db(&*host)?, &user))
            .await
            .map_err(|e| ApiError::from(e.to_string()))??
    };
    // Needs more than this user has anywhere: refused before the arguments are even read. Reading is open to
    // guests too: what they see is cut down to what is shared with them.
    let needed = if cmd.role == Role::Viewer { Role::Guest } else { cmd.role };
    if scope.best_role() < needed {
        return Err(ApiError::new(StatusCode::FORBIDDEN, format!("{command} needs the {} role", cmd.role.as_str())));
    }
    let args = if body.iter().all(|b| b.is_ascii_whitespace()) {
        serde_json::json!({})
    } else {
        serde_json::from_slice(&body).map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Bad JSON: {e}")))?
    };
    let (mut value, changed) = (cmd.call)(host, Arc::new(scope), args).await.map_err(|e| {
        // "This needs the editor role" from the scope check, named after the command
        if e.0 == StatusCode::FORBIDDEN && e.1.starts_with("This needs") { ApiError(e.0, e.1.replacen("This", &command, 1)) } else { e }
    })?;
    if !changed.is_empty() {
        // The window that made the change already shows it; it names itself so it can skip the echo
        let origin = headers.get("x-lumina-client").and_then(|v| v.to_str().ok()).unwrap_or("").chars().take(64).collect();
        announce(&state, &user, cmd.name, changed, origin).await;
    }
    state.host.hide_data_dir(&mut value);
    Ok(Json(value))
}

// Writes who changed what, and tells every connected client which photos, people or albums to refresh
async fn announce(state: &Shared, user: &User, what: &'static str, mut changed: Changed, origin: String) {
    changed.photos.sort();
    changed.photos.dedup();
    let host = state.host.clone();
    let (user_id, hashes) = (user.id, changed.photos.clone());
    let recorded = tokio::task::spawn_blocking(move || {
        let mut conn = db::open_global_db(&*host)?;
        changes::record(&mut conn, user_id, &hashes, what)
    })
    .await;
    if let Ok(Err(e)) | Err(e) = recorded.map_err(|e| e.to_string()) {
        eprintln!("[changes] couldn't record {what}: {e}");
    }
    let by = serde_json::json!({ "by": user.name, "origin": origin });
    // Albums first: a guest's socket looks at what is shared with them again on albums-changed, and then
    // gets photos-changed for a photo just added to a shared album
    if changed.albums {
        state.host.emit_value("albums-changed", by.clone());
    }
    if !changed.photos.is_empty() {
        let mut payload = by.clone();
        payload["hashes"] = serde_json::json!(changed.photos);
        state.host.emit_value("photos-changed", payload);
    }
    if changed.people {
        state.host.emit_value("people-changed", by.clone());
    }
    if !changed.shared_with.is_empty() {
        let mut payload = by.clone();
        payload["users"] = serde_json::json!(changed.shared_with);
        state.host.emit_value("shares-changed", payload);
    }
    if !changed.roles_of.is_empty() {
        let mut payload = by;
        payload["users"] = serde_json::json!(changed.roles_of);
        state.host.emit_value("roles-changed", payload);
    }
}
