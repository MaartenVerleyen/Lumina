package com.amazhr.lumina

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import app.tauri.plugin.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// The phone's backup to a server (docs/plans/android.md, milestone 3): its settings, and Android running it in
// the background whenever its conditions hold (WorkManager), also when the app is closed and after a restart.
// The work itself is Rust's (phone_backup.rs), the same upload protocol as the desktop's.
object Backup {
  private const val PERIODIC = "lumina-backup"
  private const val NOW = "lumina-backup-now"
  const val CHANNEL = "backup"

  fun prefs(context: Context) = context.getSharedPreferences("lumina-backup", Context.MODE_PRIVATE)

  // The phone's folders backed up (their RELATIVE_PATH); the camera's until others are chosen
  val DEFAULT_FOLDERS = listOf("DCIM/Camera/")

  fun folders(context: Context): JSONArray =
    prefs(context).getString("folders", null)?.let { JSONArray(it) } ?: JSONArray(DEFAULT_FOLDERS)

  fun settings(context: Context): JSObject {
    val p = prefs(context)
    return JSObject()
      .put("enabled", p.getBoolean("enabled", false))
      .put("server", p.getString("server", null))
      .put("wifiOnly", p.getBoolean("wifiOnly", true))
      .put("charging", p.getBoolean("charging", false))
      .put("videos", p.getBoolean("videos", true))
      .put("folders", folders(context))
  }

  fun configure(context: Context, enabled: Boolean, server: String?, wifiOnly: Boolean, charging: Boolean, videos: Boolean, folders: List<String>?) {
    val edit = prefs(context).edit()
    if (folders != null) edit.putString("folders", JSONArray(folders).toString())
    edit
      .putBoolean("enabled", enabled)
      .putString("server", server)
      .putBoolean("wifiOnly", wifiOnly)
      .putBoolean("charging", charging)
      .putBoolean("videos", videos)
      .commit()
    val work = WorkManager.getInstance(context)
    if (!enabled || server == null) {
      work.cancelUniqueWork(PERIODIC)
      return
    }
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
      .setRequiresCharging(charging)
      .build()
    // Every hour while the conditions hold (Android may wait for them, or batch it with other apps' work)
    val request = PeriodicWorkRequestBuilder<BackupWorker>(1, TimeUnit.HOURS).setConstraints(constraints).build()
    work.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request)
  }

  // Back up now: at once, on Wi-Fi only when that is set, unless `anyNetwork`
  // `selection`: for the photos chosen (phone_backup_selected) only
  fun now(context: Context, anyNetwork: Boolean, selection: Boolean) {
    val wifiOnly = prefs(context).getBoolean("wifiOnly", true) && !anyNetwork
    val constraints = Constraints.Builder()
      .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
      .build()
    // Expedited: Android starts it at once (a plain request can wait several seconds for the system's turn)
    val request = OneTimeWorkRequestBuilder<BackupWorker>()
      .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      .setConstraints(constraints)
      .setInputData(workDataOf("selection" to selection))
      .build()
    // One already waiting or running: this one follows it (a selection backed up while another runs is kept)
    WorkManager.getInstance(context).enqueueUniqueWork(NOW, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
  }

  // A Back up now waiting for its conditions (Wi-Fi) to start
  fun waiting(context: Context): Boolean =
    WorkManager.getInstance(context).getWorkInfosForUniqueWork(NOW).get().any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }

  fun channel(context: Context) {
    if (Build.VERSION.SDK_INT >= 26) {
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Backup", NotificationManager.IMPORTANCE_LOW))
    }
  }
}

class BackupWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
  private val notificationId = 4207

  override fun doWork(): Result {
    val prefs = Backup.prefs(applicationContext)
    val server = prefs.getString("server", null) ?: return Result.success()
    Native.init(applicationContext)
    Backup.channel(applicationContext)
    // In the foreground: a long first backup isn't stopped after Android's 10 minutes. Android may refuse
    // that while the app is in the background; the backup still runs, and the next one carries on.
    try {
      setForegroundAsync(foreground("Looking for new photos", 0, 0)).get()
    } catch (e: Exception) {
    }
    val media = try {
      PhoneStore.list(applicationContext).toString()
    } catch (e: SecurityException) {
      // Access to the photos was taken away: nothing to back up until it's given again
      return Result.success()
    }
    val dataDir = applicationContext.dataDir.path
    val ticker = Thread {
      try {
        while (true) {
          Thread.sleep(1000)
          showProgress()
        }
      } catch (e: InterruptedException) {
      }
    }
    ticker.start()
    val outcome = try {
      Native.backupPass(
        dataDir,
        server,
        media,
        prefs.getBoolean("videos", true),
        Backup.folders(applicationContext).toString(),
        inputData.getBoolean("selection", false),
      )
    } finally {
      ticker.interrupt()
    }
    return when {
      outcome.startsWith("retry") -> Result.retry()
      else -> Result.success()
    }
  }

  // An expedited backup on Android before 12 runs as a foreground service from the start: its notification
  override fun getForegroundInfo(): ForegroundInfo = foreground("Starting the backup", 0, 0)

  override fun onStopped() {
    Native.backupCancel()
  }

  private fun showProgress() {
    val p = JSONObject(Native.backupProgress())
    if (!p.optBoolean("running")) return
    val files = p.optInt("files")
    val finished = p.optInt("done") + p.optInt("failed")
    val text = if (files > 0) "${p.optString("stage")} · $finished of $files" else p.optString("stage")
    setForegroundAsync(foreground(text, finished, files))
  }

  private fun foreground(text: String, done: Int, total: Int): ForegroundInfo {
    val stop = WorkManager.getInstance(applicationContext).createCancelPendingIntent(id)
    val notification = NotificationCompat.Builder(applicationContext, Backup.CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Backing up to Lumina")
      .setContentText(text)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setProgress(total, done, total == 0)
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stop)
      .build()
    return if (Build.VERSION.SDK_INT >= 29) {
      ForegroundInfo(notificationId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      ForegroundInfo(notificationId, notification)
    }
  }
}
