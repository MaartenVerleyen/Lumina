package com.amazhr.lumina

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import androidx.core.content.FileProvider
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

@InvokeArg
class BackupArgs {
  var enabled: Boolean = false
  var server: String? = null
  var wifiOnly: Boolean = true
  var charging: Boolean = false
  var videos: Boolean = true
}

@InvokeArg
class BackupNowArgs {
  var anyNetwork: Boolean = false
}

@InvokeArg
class ShareArgs {
  lateinit var path: String
  var mime: String = "*/*"
}

// A photo or video of the phone's media store
@InvokeArg
class MediaArgs {
  var id: Long = 0
  var video: Boolean = false
  var size: Int = 320
  var mime: String = "*/*"
}

// What only Android does for Lumina (src-tauri/src/android.rs; docs/plans/android.md): the phone's photos and
// videos from its media store and their thumbnails, its share sheet, and the backup's settings (Backup.kt).
@TauriPlugin(
  permissions = [
    // Android 13 and later ask for photos and videos; earlier versions for the shared storage
    Permission(strings = [Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO], alias = "media"),
    Permission(strings = [Manifest.permission.READ_EXTERNAL_STORAGE], alias = "mediaOld"),
    Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
  ]
)
class LuminaPlugin(private val activity: Activity) : Plugin(activity) {
  // Tauri calls a plugin's commands on the UI thread: the media store's work goes to threads of its own, so
  // the grid keeps scrolling. Thumbnails newest first: after a fast scroll the rows on screen asked last, and
  // shouldn't wait for the ones scrolled past. (Files Rust opens itself, from its own threads: PhoneStore.open.)
  private val thumbs = ThreadPoolExecutor(4, 4, 0L, TimeUnit.MILLISECONDS, object : LinkedBlockingDeque<Runnable>() {
    override fun offer(e: Runnable): Boolean = offerFirst(e)
  })
  private val pool = Executors.newFixedThreadPool(1)

  private val mediaAlias get() = if (Build.VERSION.SDK_INT >= 33) "media" else "mediaOld"

  private fun uriOf(args: MediaArgs): Uri = PhoneStore.uriOf(args.id, args.video)

  // A file of the app's (a downloaded original in its cache) to another app, through Android's share sheet
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(args.path))
    send(uri, args.mime)
    invoke.resolve()
  }

  // A photo of the phone's own to another app, straight from the media store
  @Command
  fun shareMedia(invoke: Invoke) {
    val args = invoke.parseArgs(MediaArgs::class.java)
    send(uriOf(args), args.mime)
    invoke.resolve()
  }

  private fun send(uri: Uri, mime: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
      type = mime
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(Intent.createChooser(send, null))
  }

  // Every photo and video of the phone, asking once for access to them
  @Command
  fun listMedia(invoke: Invoke) {
    if (getPermissionState(mediaAlias) != PermissionState.GRANTED) {
      requestPermissionForAlias(mediaAlias, invoke, "mediaPermission")
      return
    }
    pool.execute { invoke.resolve(JSObject().put("items", PhoneStore.list(activity))) }
  }

  @PermissionCallback
  fun mediaPermission(invoke: Invoke) {
    if (getPermissionState(mediaAlias) == PermissionState.GRANTED) {
      pool.execute { invoke.resolve(JSObject().put("items", PhoneStore.list(activity))) }
    } else {
      invoke.reject("Lumina may not see this phone's photos: allow it under Settings → Apps → Lumina → Permissions")
    }
  }

  // A thumbnail of a photo or video, as a JPEG in the app's cache (made once)
  @Command
  fun thumbnail(invoke: Invoke) {
    val args = invoke.parseArgs(MediaArgs::class.java)
    val file = File(activity.cacheDir, "phone-thumbs/${if (args.video) "v" else "p"}${args.id}.jpg")
    thumbs.execute { makeThumbnail(invoke, args, file) }
  }

  private fun makeThumbnail(invoke: Invoke, args: MediaArgs, file: File) {
    try {
      if (!file.exists()) {
        file.parentFile?.mkdirs()
        val bitmap: Bitmap? = if (Build.VERSION.SDK_INT >= 29) {
          activity.contentResolver.loadThumbnail(uriOf(args), Size(args.size, args.size), null)
        } else if (args.video) {
          @Suppress("DEPRECATION")
          MediaStore.Video.Thumbnails.getThumbnail(activity.contentResolver, args.id, MediaStore.Video.Thumbnails.MINI_KIND, null)
        } else {
          @Suppress("DEPRECATION")
          MediaStore.Images.Thumbnails.getThumbnail(activity.contentResolver, args.id, MediaStore.Images.Thumbnails.MINI_KIND, null)
        }
        if (bitmap == null) throw IllegalStateException("No thumbnail")
        val part = File(file.path + ".part" + Thread.currentThread().id)
        FileOutputStream(part).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        part.renameTo(file)
      }
      invoke.resolve(JSObject().put("path", file.path))
    } catch (e: Exception) {
      invoke.reject("No thumbnail for this photo: ${e.message}")
    }
  }

  // Settings → Backup (Backup.kt)
  @Command
  fun backupSettings(invoke: Invoke) {
    invoke.resolve(Backup.settings(activity))
  }

  @Command
  fun setBackup(invoke: Invoke) {
    val args = invoke.parseArgs(BackupArgs::class.java)
    Backup.configure(activity, args.enabled, args.server, args.wifiOnly, args.charging, args.videos)
    // The backup's notification needs Android 13's permission; without it the backup runs unseen
    if (args.enabled && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", invoke, "notificationsPermission")
      return
    }
    invoke.resolve()
  }

  @PermissionCallback
  fun notificationsPermission(invoke: Invoke) {
    invoke.resolve()
  }

  @Command
  fun backupNow(invoke: Invoke) {
    val args = invoke.parseArgs(BackupNowArgs::class.java)
    Backup.now(activity, args.anyNetwork)
    invoke.resolve()
  }
}
