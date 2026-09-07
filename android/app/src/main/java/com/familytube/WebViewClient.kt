package com.familytube

import android.content.Intent
import android.util.Log
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream

/**
 * WebView client built around a strict application-origin allowlist.
 *
 * The ONLY page ever allowed to render inside this WebView (where the
 * AndroidBridge JS interface stays alive) is the trusted origin derived
 * from `BuildConfig.WEBAPP_URL`. Everything else is handled like this:
 *
 *   • main-frame http(s) URLs on another origin → opened in the system
 *     browser, never loaded here,
 *   • sub-frame/iframe navigations off the trusted origin → blocked,
 *   • `familytube://watch?v=<11-char id>` → handled internally after
 *     validating the video id against the exact YouTube id shape,
 *   • unknown/non-web schemes (javascript:, intent:, tel:, …) → rejected,
 *   • tracker/ad sub-resources → dropped to save bytes on slow links.
 *
 * No substring matching is ever used as a trust decision
 * (no `host.contains("youtube.com")`).
 */
class FamilyWebViewClient(private val activity: MainActivity) : WebViewClient() {

    companion object {
        private const val TAG = "FamilyWebViewClient"

        /** Hosts whose sub-resource requests are blocked to save bytes. */
        private val TRACKING_PATTERNS = listOf(
            "google-analytics.com",
            "googletagmanager.com",
            "doubleclick.net",
            "googlesyndication.com",
            "googleadservices.com",
            "facebook.net",
            "connect.facebook.net",
            "analytics.tiktok.com",
            "graph.facebook.com"
        )
    }

    /** Normalized trusted origin, e.g. "https://family.example.com". */
    private val trustedOrigin: String =
        AppSecurity.originOf(BuildConfig.WEBAPP_URL).orEmpty()

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?
    ): Boolean {
        val uri = request?.url ?: return false
        val url = uri.toString()
        Log.d(TAG, "shouldOverrideUrlLoading: $url (mainFrame=${request.isForMainFrame})")

        // familytube://watch?v=VIDEO_ID — our own deep link. The id is
        // validated before use; anything malformed is dropped silently.
        if (uri.scheme.equals(AppSecurity.DEEP_LINK_SCHEME, ignoreCase = true)) {
            if (request.isForMainFrame &&
                uri.host.equals(AppSecurity.DEEP_LINK_HOST, ignoreCase = true)
            ) {
                val videoId = uri.getQueryParameter(AppSecurity.DEEP_LINK_QUERY_KEY)
                if (AppSecurity.isValidVideoId(videoId)) {
                    activity.openVideoDeepLink(videoId!!)
                }
            }
            return true // never let an unknown familytube: URI navigate the WebView
        }

        // Only http(s) URLs are ever candidates for navigation.
        if (!AppSecurity.isWebScheme(uri.scheme)) {
            Log.w(TAG, "Blocked non-web scheme navigation: $url")
            return true
        }

        // Trusted origin (main frame or sub-frame) stays inside the WebView.
        if (AppSecurity.isTrustedUrl(url, trustedOrigin)) {
            return false
        }

        // Sub-frames may never leave the trusted origin — the bridge must
        // never become reachable from untrusted content.
        if (!request.isForMainFrame) {
            Log.w(TAG, "Blocked off-origin sub-frame navigation: $url")
            return true
        }

        // Any other http(s) main-frame URL opens in the system browser.
        Log.d(TAG, "Opening external URL in system browser: $url")
        try {
            activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (e: Exception) {
            Log.e(TAG, "No handler for external URL: $url", e)
        }
        return true
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val url = request?.url?.toString() ?: return null

        // Drop tracker/ad requests outright instead of fetching them. The
        // rest of the page is same-origin (fonts/icons are self-hosted and
        // media is proxied), so nothing legitimate is lost.
        val urlLower = url.lowercase()
        if (TRACKING_PATTERNS.any { urlLower.contains(it) }) {
            return WebResourceResponse(
                "text/plain",
                "utf-8",
                ByteArrayInputStream(ByteArray(0))
            )
        }
        return null
    }

    override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
        super.onPageStarted(view, url, favicon)
        // Track main-frame trust so the JS bridge can be gated. Sub-frame
        // starts are never reported here, which is why off-origin frames
        // are blocked in shouldOverrideUrlLoading instead.
        activity.onMainFrameUrlChanged(url)
    }

    override fun onReceivedError(
        view: WebView?,
        request: WebResourceRequest?,
        error: WebResourceError?
    ) {
        super.onReceivedError(view, request, error)

        // Only react to main-frame failures (sub-resource errors are normal
        // and handled by the page itself).
        if (request?.isForMainFrame != true) return

        val code = error?.errorCode ?: WebViewClient.ERROR_UNKNOWN
        val networkError = code == WebViewClient.ERROR_HOST_LOOKUP ||
            code == WebViewClient.ERROR_CONNECT ||
            code == WebViewClient.ERROR_TIMEOUT ||
            code == WebViewClient.ERROR_IO ||
            code == WebViewClient.ERROR_UNKNOWN
        if (!networkError) return

        Log.e(TAG, "Main frame network error $code for ${request.url}")
        activity.onMainFrameUrlChanged(null)
        loadOfflinePage(view)
    }

    /** Persian «اینترنت قطع است» fallback, with a retry button. */
    private fun loadOfflinePage(view: WebView?) {
        val offlineHtml = """
            <!DOCTYPE html>
            <html lang="fa" dir="rtl">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background: #0F0F0F;
                        color: #F1F1F1;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 100vh;
                        margin: 0;
                        text-align: center;
                        direction: rtl;
                    }
                    .container { padding: 24px; max-width: 320px; }
                    .icon { font-size: 64px; margin-bottom: 16px; }
                    h1 { font-size: 24px; margin: 0 0 8px 0; color: #FF0000; }
                    p { font-size: 16px; color: #AAAAAA; margin: 8px 0; line-height: 1.8; }
                    button {
                        background: #272727; color: #F1F1F1; border: none;
                        padding: 12px 28px; border-radius: 24px;
                        font-size: 16px; margin-top: 16px; cursor: pointer;
                    }
                    button:active { background: #3F3F3F; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">📡</div>
                    <h1>اینترنت قطع است</h1>
                    <p>لطفاً اتصال اینترنت خود را بررسی کنید</p>
                    <p style="font-size: 14px;">ویدیوهای دانلودشده در کتابخانه قابل مشاهده هستند</p>
                    <button onclick="AndroidBridge.reloadApp()">تلاش مجدد</button>
                </div>
            </body>
            </html>
        """.trimIndent()

        view?.loadDataWithBaseURL(null, offlineHtml, "text/html", "utf-8", null)
    }

    override fun onPageFinished(view: WebView?, url: String?) {
        super.onPageFinished(view, url)

        // Only the trusted application page gets cosmetics + the wrapper
        // marker (the data: offline fallback and any error page stay bare).
        if (url == null || !AppSecurity.isTrustedUrl(url, trustedOrigin)) return

        // Hide scrollbars — the web app styles its own scrolling surfaces.
        view?.evaluateJavascript(
            """
            (function() {
                var style = document.createElement('style');
                style.textContent = '::-webkit-scrollbar { display: none; }';
                document.head.appendChild(style);
            })();
            """.trimIndent(), null
        )

        // Let the web app know it is inside the native wrapper. The page
        // listens for the 'android-wrapper-ready' event (nativeApp.js).
        view?.evaluateJavascript(
            """
            (function() {
                window.AndroidWrapper = {
                    isNative: true,
                    platform: 'android',
                    version: '1.0.0'
                };
                window.dispatchEvent(new CustomEvent('android-wrapper-ready'));
            })();
            """.trimIndent(), null
        )

        activity.onNativePageFinished(url)
    }
}
