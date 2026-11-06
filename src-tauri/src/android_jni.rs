// Rust and the phone app's Kotlin calling each other directly (Native.kt), without Tauri's plugin bridge: that
// runs on the UI thread, and isn't there at all when the background backup starts the app without a window.
// Kotlin calls `bridge` first (MainActivity, BackupWorker); from then on Rust opens the phone's files
// (PhoneStore.open) and keeps sessions in the Keystore (TokenStore) from any of its threads.
use jni::objects::{GlobalRef, JClass, JString, JValue};
use jni::sys::{jboolean, jstring};
use jni::{JNIEnv, JavaVM};
use std::sync::OnceLock;

struct Bridge {
    vm: JavaVM,
    store: GlobalRef,
    tokens: GlobalRef,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

// A thread of Rust's own finds the app's classes only through these references: found here, on Kotlin's
// thread, where the app's class loader is the one in use
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_amazhr_lumina_Native_bridge(mut env: JNIEnv, _class: JClass) {
    if BRIDGE.get().is_some() {
        return;
    }
    let Ok(vm) = env.get_java_vm() else { return };
    let Ok(store) = env.find_class("com/amazhr/lumina/PhoneStore").and_then(|c| env.new_global_ref(c)) else { return };
    let Ok(tokens) = env.find_class("com/amazhr/lumina/TokenStore").and_then(|c| env.new_global_ref(c)) else { return };
    let _ = BRIDGE.set(Bridge { vm, store, tokens });
}

fn with_env<T>(f: impl FnOnce(&mut JNIEnv, &Bridge) -> jni::errors::Result<T>) -> Result<T, String> {
    let bridge = BRIDGE.get().ok_or("The app's Android side isn't ready")?;
    let mut env = bridge.vm.attach_current_thread_permanently().map_err(|e| e.to_string())?;
    let result = f(&mut env, bridge);
    // A Kotlin exception must not be left pending on this thread
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_clear();
    }
    result.map_err(|e| e.to_string())
}

// A photo or video of the phone's media store, to read
pub fn open_media(id: i64, video: bool) -> Result<std::fs::File, String> {
    use std::os::fd::FromRawFd;
    let fd = with_env(|env, b| {
        let class = <&JClass>::from(b.store.as_obj());
        env.call_static_method(class, "open", "(JZ)I", &[JValue::Long(id), JValue::Bool(video as jboolean)])?.i()
    })?;
    if fd < 0 {
        return Err("Couldn't open the photo (gone from the phone, or Lumina may no longer see its photos)".into());
    }
    // Kotlin detached the descriptor: it is ours to close (the File does)
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

// Whether the phone's files are read as they are (with their locations): else Android hands out copies without
pub fn reads_originals() -> bool {
    with_env(|env, b| {
        let class = <&JClass>::from(b.store.as_obj());
        env.call_static_method(class, "originals", "()Z", &[])?.z()
    })
    .unwrap_or(false)
}

// A downloaded photo into the phone's gallery, in `folder` ("Pictures/Lumina/Summer"): a followed album's
pub fn save_to_gallery(path: &std::path::Path, folder: &str) -> bool {
    with_env(|env, b| {
        let class = <&JClass>::from(b.store.as_obj());
        let (path, folder) = (env.new_string(path.to_string_lossy())?, env.new_string(folder)?);
        env.call_static_method(class, "saveToGallery", "(Ljava/lang/String;Ljava/lang/String;)Z", &[JValue::Object(&path), JValue::Object(&folder)])?.z()
    })
    .unwrap_or(false)
}

pub fn token_get(name: &str) -> Option<String> {
    with_env(|env, b| {
        let class = <&JClass>::from(b.tokens.as_obj());
        let name = env.new_string(name)?;
        let value = env.call_static_method(class, "get", "(Ljava/lang/String;)Ljava/lang/String;", &[JValue::Object(&name)])?.l()?;
        if value.is_null() {
            return Ok(None);
        }
        Ok(Some(String::from(env.get_string(&JString::from(value))?)))
    })
    .ok()
    .flatten()
}

pub fn token_set(name: &str, token: &str) -> bool {
    with_env(|env, b| {
        let class = <&JClass>::from(b.tokens.as_obj());
        let (name, token) = (env.new_string(name)?, env.new_string(token)?);
        env.call_static_method(class, "set", "(Ljava/lang/String;Ljava/lang/String;)Z", &[JValue::Object(&name), JValue::Object(&token)])?.z()
    })
    .unwrap_or(false)
}

pub fn token_delete(name: &str) {
    let _ = with_env(|env, b| {
        let class = <&JClass>::from(b.tokens.as_obj());
        let name = env.new_string(name)?;
        env.call_static_method(class, "delete", "(Ljava/lang/String;)V", &[JValue::Object(&name)])?;
        Ok(())
    });
}

fn answer(env: &mut JNIEnv, text: &str) -> jstring {
    env.new_string(text).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_amazhr_lumina_Native_backupPass(
    mut env: JNIEnv,
    _class: JClass,
    data_dir: JString,
    server: JString,
    media: JString,
    videos: jboolean,
    folders: JString,
    selection: jboolean,
    backup: jboolean,
    follows: jboolean,
) -> jstring {
    let mut text = |s: &JString| env.get_string(s).map(String::from).unwrap_or_default();
    let (data_dir, server, media, folders) = (text(&data_dir), text(&server), text(&media), text(&folders));
    let folders: Vec<String> = serde_json::from_str(&folders).unwrap_or_default();
    let outcome =
        crate::phone_backup::pass(std::path::Path::new(&data_dir), &server, &media, videos != 0, &folders, selection != 0, backup != 0, follows != 0);
    answer(&mut env, &outcome)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_amazhr_lumina_Native_backupProgress(mut env: JNIEnv, _class: JClass) -> jstring {
    let progress = serde_json::to_string(&crate::phone_backup::progress()).unwrap_or_default();
    answer(&mut env, &progress)
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_com_amazhr_lumina_Native_backupCancel(_env: JNIEnv, _class: JClass) {
    crate::phone_backup::cancel();
}
