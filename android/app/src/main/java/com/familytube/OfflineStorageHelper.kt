package com.familytube

import android.content.Context

/**
 * Storage helpers for the JS bridge (`getStorageInfo`, `clearAppCache`).
 *
 * The web app stores offline videos in IndexedDB, which lives in the
 * WebView's app-data directory (context.cacheDir / filesDir siblings). These
 * helpers report how much room the app has left and can clear the WebView's
 * cache partition so a full device can free space without uninstalling.
 */
class OfflineStorageHelper(private val context: Context) {

    /**
     * JSON object of usable bytes the bridge returns to the page, e.g.
     * {"internal": 123456789, "cache": 9876543, "webViewCache": 4096}.
     */
    fun storageInfoJson(): String {
        val internalBytes = context.filesDir.usableSpace
        val cacheBytes = context.cacheDir.usableSpace
        return """{"internal":$internalBytes,"cache":$cacheBytes}"""
    }

    /** Best-effort clear of the app cache dir; returns true on success. */
    fun clearAppCache(): Boolean {
        return try {
            val cacheDir = context.cacheDir
            if (cacheDir.exists()) {
                cacheDir.listFiles()?.forEach { file ->
                    deleteRecursively(file)
                }
            }
            true
        } catch (e: Exception) {
            android.util.Log.e("OfflineStorageHelper", "clearAppCache failed", e)
            false
        }
    }

    private fun deleteRecursively(file: java.io.File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete()
    }
}
