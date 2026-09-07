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
 * WebView client: keeps navigation inside the wrapper (except a short
 * denylist that opens in the real browser), blocks known tracker/ad hosts to
 * save bandwidth on slow links, shows a Persian offline page when the app
 * server is unreachable, and marks the page as running inside the native
 * wrapper once it loads.
 */
class FamilyWebViewClient(private val activity: MainActivity) : WebViewClient() {

    companion object {
        private const val TAG = "FamilyWebViewClient"

        /** Hosts that should open in the system browser, not our WebView. */
        private val EXTERNAL_URL_PATTERNS = listOf(
            "youtube.com",
            "google.com",
            "facebook.com",
            "twitter.com",
            "instagram.com",
            "telegram.org",
            "whatsapp.com"
        )

        /** Hosts whose requests are blocked to save bytes on slow links. */
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

    override fun shouldOverrideUrlLoading(
        view: WebView?,
        request: WebResourceRequest?
    ): Boolean {
        val url = request?.url?.toString() ?: return false
        Log.d(TAG, "Loading URL: $url")

        val uri = request?.url ?: return false
        val host = uri.host.orEmpty()

        // External sites (real YouTube, social links in descriptions, etc.)
        // go to the system browser — our WebView only serves the proxy app.
        val matchesExternal = EXTERNAL_URL_PATTERNS.any { host.contains(it) }
        if (matchesExternal) {
            try {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                return true
            } catch (e: Exception) {
                Log.e(TAG, "Failed to open external URL: $url", e)
            }
        }
        return false
    }

    override fun shouldInterceptRequest(
        view: WebView?,
        request: WebResourceRequest?
    ): WebResourceResponse? {
        val url = request?.url?.toString() ?: return null

        // Drop tracker/ad requests outright instead of fetching them.
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

        // Skip cosmetics for the data: offline fallback page.
        if (url != null && url.startsWith("data:")) return

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
