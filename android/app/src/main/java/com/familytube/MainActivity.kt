package com.familytube

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowManager
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.ProgressBar
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout

/**
 * Full-screen WebView host for the Persian YouTube shell.
 *
 * The web app handles its own navigation, offline downloads (IndexedDB) and
 * layout; this activity only wraps it: keeps the screen on while watching,
 * routes the system back button through WebView history, surfaces a Persian
 * offline page when the server is unreachable, exposes the [JavaScriptBridge]
 * ("AndroidBridge") to the page, and auto-reloads once connectivity returns.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var networkMonitor: NetworkMonitor
    private val downloadBridge by lazy { DownloadManagerBridge(this) }
    private val offlineStorage by lazy { OfflineStorageHelper(this) }

    /** Deep link (familytube://watch?v=…) received before the page finished. */
    private var pendingDeepLinkVideoId: String? = null
    private var initialPageFinished = false

    companion object {
        private const val PREFS_NAME = "FamilyTubePrefs"
        private const val KEY_LAST_URL = "last_url"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        progressBar = findViewById(R.id.progress_bar)
        swipeRefresh = findViewById(R.id.swipe_refresh)

        // Keep the screen on while watching videos.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        setupWebView()

        // Network monitoring starts in onResume (it must never double-register).
        networkMonitor = NetworkMonitor(this) { isConnected ->
            runOnUiThread {
                if (isConnected) {
                    // If we were parked on the offline fallback page, retry the
                    // real app now that the connection is back.
                    if (isShowingFallbackPage()) {
                        loadWebApp()
                    }
                } else {
                    Toast.makeText(this, getString(R.string.error_no_internet), Toast.LENGTH_SHORT).show()
                }
            }
        }

        // Intent (deep link) is parsed before the page loads; it is applied
        // once the first page has finished loading (see onNativePageFinished).
        handleIntent(intent)

        loadWebApp()
    }

    @Suppress("DEPRECATION") // setDatabaseEnabled / mixedContentMode warn on some SDK levels
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage for subscriptions/library
            databaseEnabled = true   // IndexedDB for offline downloads
            cacheMode = WebSettings.LOAD_DEFAULT

            // Autoplay is user-initiated in this app, but keep media seamless.
            mediaPlaybackRequiresUserGesture = false

            // Mixed content: dev/preview deployments may serve over HTTP while
            // some resources are HTTPS. The network security config restricts
            // which cleartext hosts are allowed.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

            // Mimic a current Chrome mobile UA — our own UI, so this only
            // matters for any site sniffing code inside the page.
            userAgentString = "Mozilla/5.0 (Linux; Android ${Build.VERSION.RELEASE}) " +
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"

            // Zoom for readability on low-end screens (double-tap + pinch).
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false

            textZoom = 100
        }

        webView.webViewClient = FamilyWebViewClient(this)
        webView.webChromeClient = FamilyWebChromeClient()

        webView.addJavascriptInterface(JavaScriptBridge(), "AndroidBridge")

        swipeRefresh.setOnRefreshListener {
            webView.reload()
            swipeRefresh.isRefreshing = false
        }

        // The app handles its own pull-to-refresh / overscroll.
        webView.overScrollMode = View.OVER_SCROLL_NEVER
    }

    private fun loadWebApp() {
        val url = BuildConfig.WEBAPP_URL
        webView.loadUrl(url)
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LAST_URL, url)
            .apply()
    }

    /** True when the WebView is parked on the offline fallback (or blank). */
    private fun isShowingFallbackPage(): Boolean {
        val url = webView.url ?: return true
        return url == "about:blank" || url.startsWith("data:")
    }

    /**
     * Parses deep links such as `familytube://watch?v=abc123`. The web app
     * has no hash router today, so the link is stored and turned into a
     * `#/watch?v=…` hash once the shell has loaded (harmless if unused).
     */
    private fun handleIntent(intent: Intent?) {
        val data: Uri? = intent?.data
        if (data == null || data.scheme != "familytube") return
        if (data.host != "watch") return
        val videoId = data.getQueryParameter("v").orEmpty()
        if (videoId.isNotEmpty()) {
            pendingDeepLinkVideoId = videoId
        }
    }

    /** Called from FamilyWebViewClient.onPageFinished (main thread). */
    fun onNativePageFinished(url: String?) {
        // Apply a pending deep link exactly once, after the first real page.
        if (!initialPageFinished) {
            initialPageFinished = true
            val videoId = pendingDeepLinkVideoId
            if (videoId != null && !videoId.isEmpty()) {
                webView.evaluateJavascript(
                    "window.location.hash = '#/watch?v=$videoId';", null
                )
                pendingDeepLinkVideoId = null
            }
        }
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            showExitDialog()
        }
    }

    private fun showExitDialog() {
        AlertDialog.Builder(this)
            .setTitle(R.string.exit_title)
            .setMessage(R.string.exit_message)
            .setPositiveButton(R.string.yes) { _, _ -> finish() }
            .setNegativeButton(R.string.no) { dialog, _ -> dialog.dismiss() }
            .show()
    }

    /**
     * "AndroidBridge" — the JavaScript interface the web app talks to through
     * `window.AndroidBridge` (see src/frontend/js/utils/nativeApp.js).
     */
    inner class JavaScriptBridge {

        @android.webkit.JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }

        @android.webkit.JavascriptInterface
        fun isNetworkAvailable(): Boolean {
            return networkMonitor.isConnected()
        }

        @android.webkit.JavascriptInterface
        fun downloadVideo(videoId: String, title: String, url: String): Boolean {
            // Offline downloads normally run inside the web app (service
            // worker + IndexedDB through the stream proxy). This native path
            // is a fallback for saving a copy to the device's Movies folder.
            downloadBridge.downloadVideo(videoId, title, url) { success ->
                runOnUiThread {
                    Toast.makeText(
                        this@MainActivity,
                        if (success) getString(R.string.download_saved)
                        else getString(R.string.download_failed),
                        Toast.LENGTH_LONG
                    ).show()
                }
            }
            return true
        }

        @android.webkit.JavascriptInterface
        fun getStorageInfo(): String {
            return offlineStorage.storageInfoJson()
        }

        @android.webkit.JavascriptInterface
        fun clearAppCache(): Boolean {
            return offlineStorage.clearAppCache()
        }

        @android.webkit.JavascriptInterface
        fun requestPersistentStorage(): Boolean {
            // Android 13+ never evicts app storage without user action. On
            // older versions ask the WebView to persist its quota (best
            // effort — the web app also keeps IndexedDB downloads working).
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                true
            } else {
                webView.evaluateJavascript("navigator.storage.persist()", null)
                true
            }
        }

        @android.webkit.JavascriptInterface
        fun shareVideo(title: String, url: String) {
            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, url)
                putExtra(Intent.EXTRA_TITLE, title)
            }
            startActivity(Intent.createChooser(shareIntent, getString(R.string.share_title)))
        }

        /** Called by the offline fallback page's «تلاش مجدد» button. */
        @android.webkit.JavascriptInterface
        fun reloadApp() {
            runOnUiThread {
                loadWebApp()
            }
        }
    }

    /** Progress line + native dialogs for JS alert/confirm. */
    private inner class FamilyWebChromeClient : WebChromeClient() {

        override fun onProgressChanged(view: WebView?, newProgress: Int) {
            super.onProgressChanged(view, newProgress)
            progressBar.progress = newProgress
            progressBar.visibility = if (newProgress < 100) View.VISIBLE else View.GONE
        }

        override fun onJsAlert(
            view: WebView?,
            url: String?,
            message: String?,
            result: JsResult?
        ): Boolean {
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setPositiveButton(R.string.ok) { _, _ -> result?.confirm() }
                .setOnCancelListener { result?.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(
            view: WebView?,
            url: String?,
            message: String?,
            result: JsResult?
        ): Boolean {
            AlertDialog.Builder(this@MainActivity)
                .setMessage(message)
                .setPositiveButton(R.string.yes) { _, _ -> result?.confirm() }
                .setNegativeButton(R.string.no) { _, _ -> result?.cancel() }
                .show()
            return true
        }
    }

    override fun onResume() {
        super.onResume()
        if (::networkMonitor.isInitialized) {
            networkMonitor.startMonitoring()
        }
    }

    override fun onPause() {
        super.onPause()
        if (::networkMonitor.isInitialized) {
            networkMonitor.stopMonitoring()
        }
    }

    override fun onDestroy() {
        if (::networkMonitor.isInitialized) {
            networkMonitor.stopMonitoring()
        }
        webView.destroy()
        super.onDestroy()
    }

    // Persist WebView state across configuration changes / process death.
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        webView.restoreState(savedInstanceState)
    }
}
