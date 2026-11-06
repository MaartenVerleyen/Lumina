package com.amazhr.lumina

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import android.view.HapticFeedbackConstants
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import app.tauri.PermissionState
import app.tauri.annotation.ActivityCallback
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
  var folders: List<String>? = null
}

@InvokeArg
class BackupNowArgs {
  var anyNetwork: Boolean = false
  var selection: Boolean = false
}

// Photos to another app: downloaded originals in the app's cache, and photos of the phone's media store
@InvokeArg
class ShareArgs {
  var files: List<String> = listOf()
  var media: List<MediaRef> = listOf()
  var mime: String = "*/*"
}

@InvokeArg
class MediaRef {
  var id: Long = 0
  var video: Boolean = false
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
    // Where the photos were taken (their GPS): without it Android strips the location from the files Lumina reads
    Permission(strings = [Manifest.permission.ACCESS_MEDIA_LOCATION], alias = "location"),
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

  // Photos to another app, through Android's share sheet
  @Command
  fun share(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    val uris = ArrayList<Uri>()
    for (path in args.files) uris.add(FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(path)))
    for (m in args.media) uris.add(PhoneStore.uriOf(m.id, m.video))
    if (uris.isEmpty()) {
      invoke.reject("Nothing to share")
      return
    }
    val send = if (uris.size == 1) {
      Intent(Intent.ACTION_SEND).putExtra(Intent.EXTRA_STREAM, uris[0])
    } else {
      Intent(Intent.ACTION_SEND_MULTIPLE).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
    }
    send.type = args.mime
    // The receiving app may read every one of them
    send.clipData = ClipData.newRawUri(null, uris[0]).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
    send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    activity.startActivity(Intent.createChooser(send, null))
    invoke.resolve()
  }

  // Downloaded originals into the phone's gallery (Pictures/Lumina, videos in Movies/Lumina), where every app
  // sees them; the media store lists them, so All photos shows them as on the phone too
  @Command
  fun saveToGallery(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    if (Build.VERSION.SDK_INT < 29) {
      invoke.reject("Saving to the gallery needs Android 10 or later")
      return
    }
    pool.execute {
      var saved = 0
      try {
        for (path in args.files) {
          val file = File(path)
          val ext = file.extension.lowercase()
          val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
          val video = mime.startsWith("video/")
          val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, file.name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, if (video) "Movies/Lumina" else "Pictures/Lumina")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
          }
          val resolver = activity.contentResolver
          val uri = resolver.insert(PhoneStore.collection(video), values) ?: continue
          resolver.openOutputStream(uri)?.use { out -> file.inputStream().use { it.copyTo(out) } }
          values.clear()
          values.put(MediaStore.MediaColumns.IS_PENDING, 0)
          resolver.update(uri, values, null, null)
          saved++
        }
        invoke.resolve(JSObject().put("saved", saved))
      } catch (e: Exception) {
        invoke.reject("Couldn't save to the phone: ${e.message}")
      }
    }
  }

  // A photo in another app: Android asks which
  @Command
  fun openWith(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    val uri = args.files.firstOrNull()?.let { FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", File(it)) }
      ?: args.media.firstOrNull()?.let { PhoneStore.uriOf(it.id, it.video) }
    if (uri == null) {
      invoke.reject("Nothing to open")
      return
    }
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, activity.contentResolver.getType(uri) ?: args.mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    activity.startActivity(Intent.createChooser(view, null))
    invoke.resolve()
  }

  // Free up space: these photos to the phone's trash. Android asks first (one question for all of them) and keeps
  // them in its trash for 30 days.
  @Command
  fun trashMedia(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)
    if (Build.VERSION.SDK_INT < 30) {
      invoke.reject("Removing photos from the phone needs Android 11 or later")
      return
    }
    if (args.media.isEmpty()) {
      invoke.resolve(JSObject().put("done", false))
      return
    }
    val uris = args.media.map { PhoneStore.uriOf(it.id, it.video) }
    val request = MediaStore.createTrashRequest(activity.contentResolver, uris, true)
    startIntentSenderForResult(invoke, IntentSenderRequest.Builder(request.intentSender).build(), "trashResult")
  }

  @ActivityCallback
  fun trashResult(invoke: Invoke, result: ActivityResult) {
    invoke.resolve(JSObject().put("done", result.resultCode == Activity.RESULT_OK))
  }

  // A short vibration (a long-press selecting a photo)
  @Command
  fun haptic(invoke: Invoke) {
    activity.window.decorView.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    invoke.resolve()
  }

  // Every photo and video of the phone, asking once for access to them
  @Command
  fun listMedia(invoke: Invoke) {
    if (getPermissionState(mediaAlias) != PermissionState.GRANTED) {
      requestPermissionForAlias(mediaAlias, invoke, "mediaPermission")
      return
    }
    listWithLocation(invoke)
  }

  // The photos' locations are asked for once, after access to the photos; the list comes either way
  private fun listWithLocation(invoke: Invoke) {
    val prefs = activity.getSharedPreferences("lumina-permissions", android.content.Context.MODE_PRIVATE)
    if (Build.VERSION.SDK_INT >= 29 && getPermissionState("location") != PermissionState.GRANTED && !prefs.getBoolean("askedLocation", false)) {
      prefs.edit().putBoolean("askedLocation", true).apply()
      requestPermissionForAlias("location", invoke, "locationPermission")
      return
    }
    pool.execute { invoke.resolve(JSObject().put("items", PhoneStore.list(activity))) }
  }

  @PermissionCallback
  fun locationPermission(invoke: Invoke) {
    pool.execute { invoke.resolve(JSObject().put("items", PhoneStore.list(activity))) }
  }

  @PermissionCallback
  fun mediaPermission(invoke: Invoke) {
    if (getPermissionState(mediaAlias) == PermissionState.GRANTED) {
      listWithLocation(invoke)
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
    Backup.configure(activity, args.enabled, args.server, args.wifiOnly, args.charging, args.videos, args.folders)
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
  fun backupWaiting(invoke: Invoke) {
    pool.execute { invoke.resolve(JSObject().put("waiting", Backup.waiting(activity))) }
  }

  @Command
  fun backupNow(invoke: Invoke) {
    val args = invoke.parseArgs(BackupNowArgs::class.java)
    Backup.now(activity, args.anyNetwork, args.selection)
    invoke.resolve()
  }
}
