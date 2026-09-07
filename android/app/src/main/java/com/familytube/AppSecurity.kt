package com.familytube

import java.net.URI

/**
 * Pure-JVM security helpers shared by the WebView host, the deep-link
 * handler and the JS bridge. Everything here must stay free of Android
 * framework classes so it can be unit-tested with plain JUnit.
 *
 * Rules enforced by the app:
 *   • deep-link video ids must match exactly the YouTube id shape,
 *   • navigation decisions compare full normalized origins (scheme + host
 *     + explicit port) — never substring matching,
 *   • URLs carrying userinfo/credentials are never trusted,
 *   • only http(s) URLs are ever opened, and only the trusted origin is
 *     ever allowed to stay inside the bridge-enabled WebView.
 */
object AppSecurity {

    /** YouTube video id: exactly 11 chars of base64url. */
    private val VIDEO_ID_REGEX = Regex("^[A-Za-z0-9_-]{11}$")

    const val DEEP_LINK_SCHEME = "familytube"
    const val DEEP_LINK_HOST = "watch"
    const val DEEP_LINK_QUERY_KEY = "v"

    fun isValidVideoId(id: String?): Boolean {
        return id != null && VIDEO_ID_REGEX.matches(id)
    }

    /**
     * Normalized origin ("scheme://host" or "scheme://host:port") of an
     * http(s) URL, or null when the URL is unparsable, not http(s), or
     * embeds credentials. Lowercase scheme/host; an explicit port equal to
     * the scheme default is kept as-is on both sides so equality still
     * holds — comparison is only ever done between two origins produced by
     * this function.
     */
    fun originOf(url: String): String? {
        val trimmed = url?.trim().orEmpty()
        if (trimmed.isEmpty()) return null
        val uri = try {
            URI(trimmed)
        } catch (_: Exception) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = uri.host?.lowercase() ?: return null
        // Embedded credentials must never be treated as a trusted origin.
        if (!uri.rawUserInfo.isNullOrEmpty()) return null
        val port = if (uri.port >= 0) ":${uri.port}" else ""
        return "$scheme://$host$port"
    }

    /** True when [candidate] is an http(s) URL on the given trusted origin. */
    fun isTrustedUrl(candidate: String, trustedOrigin: String): Boolean {
        if (trustedOrigin.isEmpty()) return false
        return originOf(candidate) == trustedOrigin
    }

    /** True when [scheme] is http or https (case-insensitive). */
    fun isWebScheme(scheme: String?): Boolean {
        val s = scheme?.lowercase() ?: return false
        return s == "http" || s == "https"
    }

    /**
     * Quotes a string for safe embedding inside JavaScript source (the
     * JSON string encoding). Used instead of raw concatenation so no
     * deep-link payload can ever inject script.
     */
    fun jsQuote(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (ch in value) {
            when (ch) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\b' -> sb.append("\\b")
                '\u000C' -> sb.append("\\f")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> {
                    if (ch.code < 0x20) {
                        sb.append(String.format("\\u%04x", ch.code))
                    } else {
                        sb.append(ch)
                    }
                }
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /** Bound a user-supplied string for use as a system-UI label. */
    fun safeLabel(value: String?, maxLength: Int = 80): String {
        val text = value?.trim().orEmpty()
        return if (text.length <= maxLength) text else text.take(maxLength)
    }
}
