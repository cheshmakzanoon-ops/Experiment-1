/**
 * URL and video-ID validation for outbound media/metadata requests.
 *
 * YouTube "googlevideo.com" stream URLs are signed and may carry arbitrary
 * query parameters, so URL shape is deliberately not constrained beyond the
 * scheme, host allowlist, and the absence of embedded credentials.
 *
 * This allowlist is the trust boundary for EVERY outbound request the proxy
 * makes (stream relay, probes, thumbnails, diagnostics) and is re-applied on
 * every redirect hop (see src/utils/net.ts).
 */

export const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/

/**
 * Hosts the server is willing to fetch media/metadata from. Matching is an
 * exact host or a subdomain of an allowlisted suffix — `googlevideo.com.evil.example`
 * never matches.
 */
export const ALLOWED_STREAM_HOSTS = [
  'googlevideo.com',
  'youtube.com',
  'youtu.be',
  'ytimg.com',
  'ggpht.com',
  'googleusercontent.com'
] as const

export function isValidVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id)
}

/** Exact host or a subdomain of an allowlisted suffix. */
export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return ALLOWED_STREAM_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  )
}

export class UnsafeUrlError extends Error {
  constructor(message: string, public reason: 'scheme' | 'host' | 'credentials' | 'malformed') {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

/**
 * Validate that an outbound URL may be fetched. External media is HTTPS
 * only; http is accepted solely for local/private diagnostics hooks that
 * explicitly opt in via `allowHttp`.
 */
export function assertSafeMediaUrl(rawUrl: string, allowHttp = false): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UnsafeUrlError('Refusing to proxy a malformed URL', 'malformed')
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError('Refusing to proxy a URL with embedded credentials', 'credentials')
  }

  const https = url.protocol === 'https:'
  const http = url.protocol === 'http:'
  if (!https && !(allowHttp && http)) {
    throw new UnsafeUrlError(`Refusing to proxy non-HTTPS URL (${url.protocol})`, 'scheme')
  }

  if (!isAllowedHost(url.hostname)) {
    throw new UnsafeUrlError(`Refusing to proxy URL from disallowed host ${url.hostname}`, 'host')
  }

  return url
}

/**
 * Resolve one redirect hop (RFC 7231): build the next absolute URL from a
 * `Location` header and re-validate it against the same allowlist as the
 * initial URL. Returns the validated absolute URL, or a rejection reason.
 * Used on EVERY hop of the manual redirect chain (see src/utils/net.ts) so
 * a safe→unsafe redirect can never slip through.
 */
export function resolveRedirectTarget(
  currentUrl: string,
  location: string | null | undefined,
  allowHttp = false
): { ok: true; url: string } | { ok: false; reason: string } {
  if (!location || location.trim() === '') {
    return { ok: false, reason: 'redirect without a Location header' }
  }
  let resolved: URL
  try {
    resolved = new URL(location.trim(), currentUrl)
  } catch {
    return { ok: false, reason: 'malformed redirect Location' }
  }
  try {
    const safe = assertSafeMediaUrl(resolved.toString(), allowHttp)
    return { ok: true, url: safe.toString() }
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof UnsafeUrlError ? error.message : 'unsafe redirect target'
    }
  }
}
