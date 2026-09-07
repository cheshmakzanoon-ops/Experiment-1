/**
 * URL and video ID validation helpers.
 *
 * YouTube "googlevideo.com" stream URLs are signed and can contain arbitrary
 * query parameters, so validation is deliberately conservative: we only
 * restrict the scheme and the host suffix, never the full URL shape.
 */

/** YouTube video IDs are exactly 11 chars of [A-Za-z0-9_-]. */
export const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/

/** Hosts we are willing to proxy media/metadata from. */
export const ALLOWED_STREAM_HOSTS = [
  'googlevideo.com',
  'youtube.com',
  'youtu.be',
  'ytimg.com',
  'ggpht.com',
  'googleusercontent.com'
]

export function isValidVideoId(id: string): boolean {
  return VIDEO_ID_RE.test(id)
}

/**
 * Normalize a hostname and check it (or a subdomain of it) is allowed.
 */
export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, '')
  return ALLOWED_STREAM_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`)
  )
}

/**
 * Parse a video ID out of either a bare ID or common YouTube URL shapes
 * (watch?v=, youtu.be/, shorts/, embed/). Returns null when not valid.
 */
export function parseVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (VIDEO_ID_RE.test(trimmed)) return trimmed

  try {
    const url = new URL(trimmed)
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.split('/').filter(Boolean)[0] || ''
      return isValidVideoId(id) ? id : null
    }
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v')
      if (v && isValidVideoId(v)) return v
      // /shorts/<id>, /embed/<id>, /v/<id>
      const parts = url.pathname.split('/').filter(Boolean)
      const maybeId = parts[parts.length - 1]
      if (isValidVideoId(maybeId)) return maybeId
    }
  } catch {
    // Not a URL and not a bare 11-char id
    return null
  }
  return null
}

/**
 * Validate that a stream URL is http(s) and points at an allowed host.
 * Throws when unsafe. Used before the server relays bytes downstream.
 */
export function assertSafeStreamUrl(rawUrl: string): URL {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('Refusing to proxy invalid stream URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing to proxy non-http URL (${url.protocol})`)
  }
  if (!isAllowedHost(url.hostname)) {
    throw new Error(`Refusing to proxy URL from disallowed host ${url.hostname}`)
  }
  return url
}
