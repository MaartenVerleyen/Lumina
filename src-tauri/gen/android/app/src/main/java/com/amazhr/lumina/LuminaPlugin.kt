package com.amazhr.lumina

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
  lateinit var path: String
  var mime: String = "*/*"
}

// What only Android does for Lumina (src-tauri/src/android.rs; docs/plans/android.md): its share sheet now,
// the camera roll and background backup later
@TauriPlugin
class LuminaPlugin(private val activity: Activity) : Plugin(activity) {
  // A file of the app's (a downloaded original in its cache) to another app, through Android's share sheet
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(args.path))
    val send = Intent(Intent.ACTION_SEND).apply {
      type = args.mime
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(Intent.createChooser(send, null))
    invoke.resolve()
  }
}
