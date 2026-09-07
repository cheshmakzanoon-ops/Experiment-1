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
 *
 * Security invariants (see AppSecurity.kt):
 *   • the WebView only ever renders the trusted origin derived from
 *     BuildConfig.WEBAPP_URL (enforced by FamilyWebViewClient),
 *   • deep-link video ids must match the exact YouTube id shape before any
 *     use, and are inserted into JavaScript only through JSON quoting,
 *   • every JS-bridge method that touches network/storage first verifies
 *     the current main frame is the trusted origin,
 *   • the native download path never trusts a caller-supplied URL — it
 *     rebuilds the URL from the trusted origin + validated video id.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var progressBar: ProgressBar
    private lateinit var swipeRefresh: SwipeRefreshLayout
    private lateinit var networkMonitor: NetworkMonitor
    private val downloadBridge by lazy { DownloadManagerBridge(this) }
    private val offlineStorage by lazy { OfflineStorageHelper(this) }

    /** Normalized trusted origin, e.g. "https://family.example.com". */
    private val trustedOrigin: String =
        AppSecurity.originOf(BuildConfig.WEBAPP_URL).orEmpty()

    /** True while the main frame is on the trusted origin (bridge gate). */
    @Volatile
    private var mainFrameTrusted = false

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
        // once the first trusted page has finished loading.
        handleIntent(intent)

        loadWebApp()
    }

    @Suppress("DEPRECATION") // setDatabaseEnabled warns on some SDK levels
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage for subscriptions/library
            databaseEnabled = true   // IndexedDB for offline downloads
            cacheMode = WebSettings.LOAD_DEFAULT

            // Autoplay is user-initiated in this app, but keep media seamless.
            mediaPlaybackRequiresUserGesture = false

            // The app is fully same-origin (UI + proxied media): never mix
            // cleartext into an HTTPS page.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

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

        // The bridge is added once; every method re-validates that the
        // current main frame is the trusted origin before acting, so the
        // interface can never be abused from untrusted content.
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

    // -----------------------------------------------------------------------
    // Trusted-origin tracking (main thread; read by bridge methods)
    // -----------------------------------------------------------------------

    /** Called by FamilyWebViewClient whenever the main-frame URL changes. */
    fun onMainFrameUrlChanged(url: String?) {
        mainFrameTrusted = url != null && AppSecurity.isTrustedUrl(url, trustedOrigin)
        if (!mainFrameTrusted) {
            // Untrusted content must never carry the app's deep-link state.
            pendingDeepLinkVideoId = null
        }
    }

    /** Bridge gate: only the trusted origin may touch native capabilities. */
    fun isBridgeAllowed(): Boolean = mainFrameTrusted

    // -----------------------------------------------------------------------
    // Deep links
    // -----------------------------------------------------------------------

    /**
     * Parses deep links such as `familytube://watch?v=abc123`. The video id
     * is validated against the exact YouTube id shape before it is stored;
     * anything else is ignored. The web app has no hash router today, so
     * the link is turned into a `#/watch?v=…` hash once the shell has
     * loaded (harmless if unused).
     */
    private fun handleIntent(intent: Intent?) {
        val data: Uri? = intent?.data
        if (data == null ||
            !data.scheme.equals(AppSecurity.DEEP_LINK_SCHEME, ignoreCase = true) ||
            !data.host.equals(AppSecurity.DEEP_LINK_HOST, ignoreCase = true)
        ) {
            return
        }
        val videoId = data.getQueryParameter(AppSecurity.DEEP_LINK_QUERY_KEY)
        if (AppSecurity.isValidVideoId(videoId)) {
            pendingDeepLinkVideoId = videoId
        }
    }

    /** Called from FamilyWebViewClient for a validated familytube link. */
    fun openVideoDeepLink(videoId: String) {
        if (!AppSecurity.isValidVideoId(videoId)) return
        runOnUiThread {
            if (initialPageFinished && mainFrameTrusted) {
                applyDeepLink(videoId)
            } else {
                pendingDeepLinkVideoId = videoId
            }
        }
    }

    /** Called from FamilyWebViewClient.onPageFinished (main thread). */
    fun onNativePageFinished(url: String?) {
        // Only the trusted origin's first real page counts as "finished".
        if (url == null || !AppSecurity.isTrustedUrl(url, trustedOrigin)) return
        if (!initialPageFinished) {
            initialPageFinished = true
            val videoId = pendingDeepLinkVideoId
            if (videoId != null) {
                applyDeepLink(videoId)
                pendingDeepLinkVideoId = null
            }
        }
    }

    /** Navigate to the watch hash — the id is JSON-quoted, never raw. */
    private fun applyDeepLink(videoId: String) {
        // videoId is regex-validated already; quoting is defense in depth.
        val quoted = AppSecurity.jsQuote("watch?v=$videoId")
        webView.evaluateJavascript("window.location.hash = '#/' + $quoted;", null)
    }

    /** Deep links arriving while the activity is already running. */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        handleIntent(intent)
        val videoId = pendingDeepLinkVideoId
        if (videoId != null && initialPageFinished && mainFrameTrusted) {
            pendingDeepLinkVideoId = null
            applyDeepLink(videoId)
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
     *
     * Methods that expose native capabilities (share sheet, storage info,
     * downloads, cache clearing) refuse to run unless the current main
     * frame is the trusted application origin — so even if some untrusted
     * frame ever got script into the WebView, it could not reach them.
     */
    inner class JavaScriptBridge {

        @android.webkit.JavascriptInterface
        fun showToast(message: String) {
            // Cosmetic only — always allowed.
            runOnUiThread {
                Toast.makeText(this@MainActivity, AppSecurity.safeLabel(message, 120), Toast.LENGTH_SHORT).show()
            }
        }

        @android.webkit.JavascriptInterface
        fun isNetworkAvailable(): Boolean {
            if (!isBridgeAllowed()) return false
            return networkMonitor.isConnected()
        }

        @android.webkit.JavascriptInterface
        fun downloadVideo(videoId: String, title: String, url: String): Boolean {
            // Never trust a caller-supplied URL. Only a validated video id
            // on the trusted origin may be enqueued, and the URL is rebuilt
            // canonically from the trusted origin + the id.
            if (!isBridgeAllowed()) return false
            if (!AppSecurity.isValidVideoId(videoId)) return false
            val canonicalUrl = "$trustedOrigin/api/stream/$videoId?quality=240"
            downloadBridge.downloadVideo(
                videoId,
                AppSecurity.safeLabel(title),
                canonicalUrl
            ) { success ->
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
            if (!isBridgeAllowed()) return "{}"
            return offlineStorage.storageInfoJson()
        }

        @android.webkit.JavascriptInterface
        fun clearAppCache(): Boolean {
            if (!isBridgeAllowed()) return false
            return offlineStorage.clearAppCache()
        }

        @android.webkit.JavascriptInterface
        fun requestPersistentStorage(): Boolean {
            if (!isBridgeAllowed()) return false
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
            if (!isBridgeAllowed()) return
            val shareUrl = url.trim()
            // Only http(s) URLs may leave the device via the share sheet.
            val uri = try {
                Uri.parse(shareUrl)
            } catch (_: Exception) {
                return
            }
            if (!AppSecurity.isWebScheme(uri.scheme)) return

            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, shareUrl)
                putExtra(Intent.EXTRA_TITLE, AppSecurity.safeLabel(title))
            }
            startActivity(Intent.createChooser(shareIntent, getString(R.string.share_title)))
        }

        /** Called by the offline fallback page's «تلاش مجدد» button. */
        @android.webkit.JavascriptInterface
        fun reloadApp() {
            // Deliberately NOT gated: the fallback page only ever re-loads
            // the trusted application URL.
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
