package com.amazhr.lumina

import android.content.Context

// Lumina's Rust side, called from Kotlin (src-tauri/src/android_jni.rs): the backup pass, and the bridge Rust
// uses to call back (PhoneStore for files, TokenStore for sessions). Also usable while the app isn't open,
// when the background backup starts the process without a window.
object Native {
  init {
    System.loadLibrary("photo_triage_lib")
  }

  // Before Rust needs files or sessions: on the app's start, and in a background backup
  fun init(context: Context) {
    PhoneStore.context = context.applicationContext
    TokenStore.context = context.applicationContext
    bridge()
  }

  @JvmStatic private external fun bridge()

  // One run of the background worker: the backup of the phone's photos (media: PhoneStore.list as JSON, folders:
  // the folders backed up as JSON) to the server, or (selection) of the photos chosen for it, when `backup`; then
  // the albums followed onto the phone, when `follows`. Answers "done", "busy", "retry: <why>", "signed-out" or
  // "error: <why>".
  @JvmStatic external fun backupPass(
    dataDir: String,
    server: String,
    media: String,
    videos: Boolean,
    folders: String,
    selection: Boolean,
    backup: Boolean,
    follows: Boolean,
  ): String

  // How the backup running now is getting on, as JSON
  @JvmStatic external fun backupProgress(): String

  @JvmStatic external fun backupCancel()
}
