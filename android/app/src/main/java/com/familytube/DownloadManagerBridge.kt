package com.familytube

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Environment

/**
 * Bridge for saving videos through Android's DownloadManager.
 *
 * Kept for a future native-download enhancement (sharing files to the
 * Downloads folder / other apps). Today the web app downloads offline copies
 * itself via the service worker + IndexedDB download manager, which streams
 * through the byte-relay proxy — so this class is not called yet.
 */
class DownloadManagerBridge(private val context: Context) {

    private val downloadManager: DownloadManager by lazy {
        context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    }

    /**
     * Enqueue a download into the app's external files dir (no storage
     * permission needed). `onComplete` fires when the download finishes.
     *
     * @return the DownloadManager request id, or -1 if enqueueing failed.
     */
    fun downloadVideo(
        videoId: String,
        title: String,
        url: String,
        onComplete: (Boolean) -> Unit
    ): Long {
        val request = DownloadManager.Request(Uri.parse(url)).apply {
            setTitle(title)
            setDescription("دانلود ویدیو — $title")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalFilesDir(
                context,
                Environment.DIRECTORY_MOVIES,
                "familytube/$videoId.mp4"
            )
            // Offline-first household on slow links: don't eat a metered cap.
            setAllowedOverMetered(false)
            setAllowedOverRoaming(false)
        }

        val downloadId: Long = try {
            downloadManager.enqueue(request)
        } catch (e: Exception) {
            // Malformed URL, missing DownloadManager, etc.
            android.util.Log.e("DownloadManagerBridge", "enqueue failed for $videoId", e)
            onComplete(false)
            return -1
        }

        // ACTION_DOWNLOAD_COMPLETE is a protected system broadcast, so no
        // RECEIVER_EXPORTED/NOT_EXPORTED flag is required on API 33+.
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id != downloadId) return

                val cursor = downloadManager.query(
                    DownloadManager.Query().setFilterById(downloadId)
                )
                var success = false
                if (cursor.moveToFirst()) {
                    val status = cursor.getInt(
                        cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS)
                    )
                    success = status == DownloadManager.STATUS_SUCCESSFUL
                }
                cursor.close()
                try {
                    context.unregisterReceiver(this)
                } catch (_: IllegalArgumentException) {
                    // already unregistered
                }
                onComplete(success)
            }
        }
        context.registerReceiver(receiver, filter)
        return downloadId
    }
}
