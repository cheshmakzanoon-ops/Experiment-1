package com.familytube

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure-JVM tests for AppSecurity — no Android runtime required. */
class AppSecurityTest {

    // --- video id validation -------------------------------------------------

    @Test
    fun validVideoIdsAreAccepted() {
        assertTrue(AppSecurity.isValidVideoId("dQw4w9WgXcQ"))
        assertTrue(AppSecurity.isValidVideoId("M7lc1UVf-VE"))
        assertTrue(AppSecurity.isValidVideoId("aBcDeFgHiJk_"))
        assertTrue(AppSecurity.isValidVideoId("1234567890-"))
    }

    @Test
    fun malformedVideoIdsAreRejected() {
        assertFalse(AppSecurity.isValidVideoId(""))
        assertFalse(AppSecurity.isValidVideoId("short"))
        assertFalse(AppSecurity.isValidVideoId("toooooooooooolong!"))
        assertFalse(AppSecurity.isValidVideoId("has spaces 1234"))
        assertFalse(AppSecurity.isValidVideoId("contains.dot.123"))
        assertFalse(AppSecurity.isValidVideoId("javascript:alert(1)"))
        assertFalse(AppSecurity.isValidVideoId("dQw4w9WgXcQ\"));alert(1)//"))
        assertFalse(AppSecurity.isValidVideoId(null))
    }

    // --- origin parsing ------------------------------------------------------

    @Test
    fun trustedOriginParsesSchemeHostPort() {
        assertEquals("https://example.com", AppSecurity.originOf("https://example.com/"))
        assertEquals("https://example.com", AppSecurity.originOf("https://example.com"))
        assertEquals("https://example.com", AppSecurity.originOf("HTTPS://EXAMPLE.COM:443/watch"))
        assertEquals("http://localhost:3000", AppSecurity.originOf("http://localhost:3000"))
        assertEquals("https://app.freebuff.app", AppSecurity.originOf("https://app.freebuff.app/x/y"))
    }

    @Test
    fun unsafeUrlsAreNeverTrusted() {
        // Not http(s).
        assertNull(AppSecurity.originOf("familytube://watch?v=dQw4w9WgXcQ"))
        assertNull(AppSecurity.originOf("javascript:alert(1)"))
        assertNull(AppSecurity.originOf("data:text/html,hi"))
        assertNull(AppSecurity.originOf("file:///etc/passwd"))
        assertNull(AppSecurity.originOf("intent://example.com"))
        // Malformed.
        assertNull(AppSecurity.originOf(""))
        assertNull(AppSecurity.originOf("not a url"))
        // Embedded credentials are rejected outright.
        assertNull(AppSecurity.originOf("https://user:pass@example.com"))
    }

    // --- trust decisions -----------------------------------------------------

    @Test
    fun suffixHostsAreNotTrusted() {
        val trusted = "https://example.com"
        // Malicious suffix/prefix lookalikes must not pass.
        assertFalse(AppSecurity.isTrustedUrl("https://example.com.evil.example", trusted))
        assertFalse(AppSecurity.isTrustedUrl("https://evil-example.com", trusted))
        assertFalse(AppSecurity.isTrustedUrl("https://notexample.com", trusted))
        assertFalse(AppSecurity.isTrustedUrl("http://example.com", trusted)) // scheme change
        assertFalse(AppSecurity.isTrustedUrl("https://example.com:8443", trusted)) // port change
        assertFalse(AppSecurity.isTrustedUrl("https://example.com@evil.example", trusted))
    }

    @Test
    fun sameOriginIsTrusted() {
        val trusted = "https://example.com"
        assertTrue(AppSecurity.isTrustedUrl("https://example.com", trusted))
        assertTrue(AppSecurity.isTrustedUrl("https://example.com/", trusted))
        assertTrue(AppSecurity.isTrustedUrl("https://example.com/api/stream/x?q=1", trusted))
        assertTrue(AppSecurity.isTrustedUrl("https://example.com:443", trusted))
    }

    @Test
    fun externalNavigationDecisionIsStrict() {
        // Our own app origin stays in the WebView...
        val trusted = "https://app.freebuff.app"
        assertTrue(AppSecurity.isTrustedUrl("https://app.freebuff.app/", trusted))
        // ...real YouTube and any other origin goes to the browser.
        assertFalse(AppSecurity.isTrustedUrl("https://www.youtube.com/watch?v=x", trusted))
        assertFalse(AppSecurity.isTrustedUrl("https://youtube.com", trusted))
        assertFalse(AppSecurity.isTrustedUrl("https://sub.freebuff.app", trusted))
        assertFalse(AppSecurity.isTrustedUrl("https://freebuff.app", trusted))
    }

    // --- JS quoting (injection safety) ---------------------------------------

    @Test
    fun jsQuoteEscapesInjectionPayloads() {
        assertEquals("\"abc\"", AppSecurity.jsQuote("abc"))
        val evil = "watch?v=dQw4w9WgXcQ\");alert(1);//"
        val quoted = AppSecurity.jsQuote(evil)
        assertFalse(quoted.contains("alert"))
        assertTrue(quoted.contains("\\\""))
        // Backslashes and newlines are escaped too.
        assertEquals("\"a\\\\b\"", AppSecurity.jsQuote("a\\b"))
        assertEquals("\"a\\nb\"", AppSecurity.jsQuote("a\nb"))
    }

    // --- label bounding ------------------------------------------------------

    @Test
    fun labelsAreBounded() {
        assertEquals("short", AppSecurity.safeLabel("short"))
        assertEquals(80, AppSecurity.safeLabel("x".repeat(200)).length)
        assertEquals("", AppSecurity.safeLabel(null))
    }
}
