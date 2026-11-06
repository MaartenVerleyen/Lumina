package com.amazhr.lumina

import android.Manifest
import android.annotation.SuppressLint
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject

// The phone's photos and videos in Android's media store: the list (All photos, the backup) and their files,
// which Rust reads itself (content ids, uploads) through `open`
object PhoneStore {
  lateinit var context: Context

  fun collection(video: Boolean): Uri =
    if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI

  fun uriOf(id: Long, video: Boolean): Uri = ContentUris.withAppendedId(collection(video), id)

  fun list(context: Context): JSArray {
    val items = JSArray()
    for (video in listOf(false, true)) {
      val columns = mutableListOf(
        MediaStore.MediaColumns._ID,
        MediaStore.MediaColumns.DISPLAY_NAME,
        MediaStore.MediaColumns.SIZE,
        MediaStore.MediaColumns.DATE_MODIFIED,
        MediaStore.MediaColumns.MIME_TYPE,
        MediaStore.MediaColumns.WIDTH,
        MediaStore.MediaColumns.HEIGHT,
        MediaStore.Images.ImageColumns.DATE_TAKEN,
      )
      if (video) columns.add(MediaStore.Video.VideoColumns.DURATION)
      if (Build.VERSION.SDK_INT >= 29) columns.add(MediaStore.MediaColumns.RELATIVE_PATH)
      context.contentResolver.query(collection(video), columns.toTypedArray(), null, null, null)?.use { c ->
        val col = { name: String -> c.getColumnIndex(name) }
        while (c.moveToNext()) {
          val item = JSObject()
          item.put("id", c.getLong(col(MediaStore.MediaColumns._ID)))
          item.put("video", video)
          item.put("name", c.getString(col(MediaStore.MediaColumns.DISPLAY_NAME)) ?: "")
          item.put("size", c.getLong(col(MediaStore.MediaColumns.SIZE)))
          item.put("modified", c.getLong(col(MediaStore.MediaColumns.DATE_MODIFIED)))
          item.put("mime", c.getString(col(MediaStore.MediaColumns.MIME_TYPE)) ?: "")
          item.put("width", c.getInt(col(MediaStore.MediaColumns.WIDTH)))
          item.put("height", c.getInt(col(MediaStore.MediaColumns.HEIGHT)))
          item.put("taken", c.getLong(col(MediaStore.Images.ImageColumns.DATE_TAKEN)))
          if (video) item.put("duration", c.getLong(col(MediaStore.Video.VideoColumns.DURATION)))
          if (Build.VERSION.SDK_INT >= 29) item.put("folder", c.getString(col(MediaStore.MediaColumns.RELATIVE_PATH)) ?: "")
          items.put(item)
        }
      }
    }
    return items
  }

  // Whether Lumina reads the files as they are: with the access to the photos' locations Android gives the
  // original, else a copy with the location taken out (other bytes, so another content id, and no GPS)
  fun readsOriginals(): Boolean =
    Build.VERSION.SDK_INT < 29 || context.checkSelfPermission(Manifest.permission.ACCESS_MEDIA_LOCATION) == PackageManager.PERMISSION_GRANTED

  // A file descriptor of the photo or video for Rust, which closes it; -1 when it can't be opened. Called
  // from Rust's own threads, so it never touches the UI.
  @SuppressLint("Recycle")
  @JvmStatic
  fun open(id: Long, video: Boolean): Int {
    val uri = uriOf(id, video)
    if (Build.VERSION.SDK_INT >= 29 && readsOriginals()) {
      try {
        context.contentResolver.openFileDescriptor(MediaStore.setRequireOriginal(uri), "r")?.let { return it.detachFd() }
      } catch (e: Exception) {
      }
    }
    return try {
      context.contentResolver.openFileDescriptor(uri, "r")?.detachFd() ?: -1
    } catch (e: Exception) {
      -1
    }
  }

  // For Rust: whether the files it reads have their locations (it reads them again once they do)
  @JvmStatic
  fun originals(): Boolean = readsOriginals()
}
