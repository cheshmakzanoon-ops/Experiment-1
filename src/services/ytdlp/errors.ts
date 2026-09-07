/**
 * yt-dlp failure taxonomy.
 *
 * Every failure of the runtime is classified into exactly one category so
 * routes can produce an honest, stable client response and the retry policy
 * can distinguish "never retry" from "retry a bounded number of times".
 *
 * Deliberate fixes vs. the old implementation:
 *   - "requested format is not available" is FORMAT_UNAVAILABLE, NOT bot
 *     detection or a 403.
 *   - an explicit HTTP 429 is RATE_LIMIT and is NOT auto-retried (a retry
 *     storm makes the rate limit worse).
 *   - a 403 during extraction is FORBIDDEN (egress blocked) and is not
 *     retried — retries cannot repair a blocked IP. (A *cached URL* 403 on
 *     the media CDN is handled separately in the stream proxy as a one-time
 *     stale-URL refresh.)
 *   - process timeouts / DNS / connect / transient network errors get a
 *     small bounded retry with jittered backoff.
 *   - genuinely unknown errors get ONE careful bounded retry.
 */

export const YT_ERROR_CATEGORIES = [
  'video_unavailable',
  'private',
  'members_only',
  'age_restricted',
  'geo_restricted',
  'drm',
  'live_stream',
  'format_unavailable',
  'bot_detection',
  'rate_limit',
  'forbidden',
  'dns_error',
  'connect_timeout',
  'process_timeout',
  'network_error',
  'malformed_output',
  'runtime_missing',
  'unknown'
] as const

export type YtErrorCategory = (typeof YT_ERROR_CATEGORIES)[number]

/**
 * Categories that are never retried by the bounded retry layer:
 * content-level failures, IP/CDN blocks, explicit rate limits (retrying a
 * true 429 makes it worse) and bot walls (persistent for an egress IP).
 */
const PERMANENT_CATEGORIES = new Set<YtErrorCategory>([
  'video_unavailable',
  'private',
  'members_only',
  'age_restricted',
  'geo_restricted',
  'drm',
  'live_stream',
  'format_unavailable',
  'forbidden',
  'rate_limit',
  'bot_detection',
  'malformed_output',
  'runtime_missing'
])

export function isPermanentCategory(category: YtErrorCategory): boolean {
  return PERMANENT_CATEGORIES.has(category)
}

export function categoryIsRetryable(category: YtErrorCategory): boolean {
  return !PERMANENT_CATEGORIES.has(category)
}

/**
 * HTTP-ish status exposed to routes. `forbidden` and `bot_detection` both
 * surface as 429 so the household UI treats them as "YouTube is blocking us
 * right now" (they are distinct categories internally).
 */
export function categoryToStatus(category: YtErrorCategory): number {
  switch (category) {
    case 'video_unavailable':
      return 404
    case 'private':
    case 'members_only':
    case 'age_restricted':
    case 'geo_restricted':
    case 'drm':
      return 403
    case 'live_stream':
      return 501
    case 'format_unavailable':
      return 400
    case 'rate_limit':
    case 'bot_detection':
    case 'forbidden':
      return 429
    case 'process_timeout':
      return 504
    case 'dns_error':
    case 'connect_timeout':
    case 'network_error':
      return 502
    case 'malformed_output':
    case 'unknown':
    case 'runtime_missing':
    default:
      return 500
  }
}

export class YtDlpError extends Error {
  readonly category: YtErrorCategory
  /** HTTP-ish status for route mapping. */
  readonly status: number
  /** Never retried when false. */
  readonly retryable: boolean
  /** Stable machine code for clients, e.g. VIDEO_NOT_FOUND. */
  readonly code: string
  readonly originalError?: unknown

  constructor(
    message: string,
    category: YtErrorCategory,
    options: { originalError?: unknown } = {}
  ) {
    super(message)
    this.name = 'YtDlpError'
    this.category = category
    this.status = categoryToStatus(category)
    this.retryable = categoryIsRetryable(category)
    this.code = categoryToCode(category)
    this.originalError = options.originalError
  }
}

export function categoryToCode(category: YtErrorCategory): string {
  switch (category) {
    case 'video_unavailable':
      return 'VIDEO_NOT_FOUND'
    case 'private':
    case 'members_only':
    case 'age_restricted':
    case 'geo_restricted':
    case 'drm':
      return 'CONTENT_RESTRICTED'
    case 'live_stream':
      return 'LIVE_NOT_SUPPORTED'
    case 'format_unavailable':
      return 'FORMAT_UNAVAILABLE'
    case 'bot_detection':
      return 'YT_BOT_WALL'
    case 'rate_limit':
      return 'YT_RATE_LIMITED'
    case 'forbidden':
      return 'YT_EGRESS_BLOCKED'
    case 'dns_error':
      return 'DNS_ERROR'
    case 'connect_timeout':
      return 'CONNECT_TIMEOUT'
    case 'process_timeout':
      return 'PROCESS_TIMEOUT'
    case 'network_error':
      return 'NETWORK_ERROR'
    case 'malformed_output':
      return 'MALFORMED_OUTPUT'
    case 'runtime_missing':
      return 'RUNTIME_MISSING'
    case 'unknown':
    default:
      return 'YTDLP_ERROR'
  }
}

const TEXT_BOT = /sign in to confirm|confirm you're not a bot|not a bot|bot check|unusual traffic|recaptcha|403[\s\S]{0,80}bot/i
const TEXT_429 = /http error 429|too many requests|rate[- ]limit|retry later/i
const TEXT_403 = /http error 403|forbidden|unavailable for copyright|video is unavailable for this (server|request)/i
const TEXT_NOT_FOUND = /video unavailable|this video is unavailable|video not found|is not a valid url|unsupported url|http error 404|no video formats found/i
const TEXT_PRIVATE = /private video|this video is private/i
const TEXT_MEMBERS = /members-only|join this channel/i
const TEXT_AGE = /age[- ]restricted|confirm your age|age gate|sign in to confirm your age/i
const TEXT_GEO = /geo[- ]restricted|not available in your country|not available on this server|this content is not available in your location/i
const TEXT_DRM = /drm|playback on other applications has been disabled|video is protected/i
const TEXT_LIVE = /live stream|is currently live|livestream/i
const TEXT_FORMAT = /requested format is not available|no video formats|format.*not available/i
const TEXT_TIMEOUT = /timed out|timeout/i
const TEXT_DNS = /getaddrinfo|failed to resolve|eai_again|temporary failure in name resolution|dns/i
const TEXT_CONNECT = /econnrefused|connect timed out|connection timed out|econnreset|socket.*timed out|unable to connect/i
const TEXT_NETWORK = /network|connection|unable to download webpage|http error 5\d\d|server returned error/i

function normalize(text: string): string {
  return `${text}`.replace(/\u2019/g, "'").toLowerCase()
}

/**
 * Classify combined yt-dlp stderr/stdout text into a failure category.
 * Order matters: specific content errors are checked before generic
 * network/403 patterns.
 */
export function classifyYtDlpText(text: string): YtErrorCategory {
  const t = normalize(text)

  if (TEXT_NOT_FOUND.test(t)) return 'video_unavailable'
  if (TEXT_PRIVATE.test(t)) return 'private'
  if (TEXT_MEMBERS.test(t)) return 'members_only'
  if (TEXT_AGE.test(t)) return 'age_restricted'
  if (TEXT_GEO.test(t)) return 'geo_restricted'
  if (TEXT_DRM.test(t)) return 'drm'
  if (TEXT_LIVE.test(t)) return 'live_stream'
  if (TEXT_FORMAT.test(t)) return 'format_unavailable'
  if (TEXT_BOT.test(t)) return 'bot_detection'
  if (TEXT_429.test(t)) return 'rate_limit'
  if (TEXT_403.test(t)) return 'forbidden'
  if (TEXT_TIMEOUT.test(t)) return 'process_timeout'
  if (TEXT_DNS.test(t)) return 'dns_error'
  if (TEXT_CONNECT.test(t)) return 'connect_timeout'
  if (TEXT_NETWORK.test(t)) return 'network_error'
  return 'unknown'
}

export function classifyChildProcessFailure(
  error: { code?: string | number; stderr?: string; stdout?: string; message?: string; killed?: boolean; signal?: string },
  context = ''
): YtDlpError {
  const stderr = error.stderr || ''
  const stdout = error.stdout || ''
  const message = error.message || ''
  const combined = `${stderr} ${stdout} ${message} ${context}`

  if (error.code === 'ENOENT') {
    return new YtDlpError('yt-dlp executable not found', 'runtime_missing', { originalError: error })
  }

  const killedByTimeout = error.killed === true || (error.signal !== undefined && error.signal !== null)

  const category = classifyYtDlpText(combined)
  if (category !== 'unknown') {
    return new YtDlpError(publicMessageFor(category), category, { originalError: error })
  }
  if (killedByTimeout) {
    return new YtDlpError('yt-dlp process timed out', 'process_timeout', { originalError: error })
  }
  return new YtDlpError('yt-dlp failed with an unknown error', 'unknown', { originalError: error })
}

/** Short client-safe description — never raw stderr. */
export function publicMessageFor(category: YtErrorCategory): string {
  switch (category) {
    case 'video_unavailable':
      return 'Video not found'
    case 'private':
      return 'This video is private'
    case 'members_only':
      return 'Members-only content'
    case 'age_restricted':
      return 'Age-restricted video'
    case 'geo_restricted':
      return 'Video not available in this region'
    case 'drm':
      return 'DRM-protected content'
    case 'live_stream':
      return 'Live streams are not supported'
    case 'format_unavailable':
      return 'Requested format is not available for this video'
    case 'bot_detection':
      return 'YouTube is asking for bot confirmation (temporary)'
    case 'rate_limit':
      return 'YouTube rate-limited this request (temporary)'
    case 'forbidden':
      return 'YouTube refused this request (egress may be blocked)'
    case 'dns_error':
      return 'DNS resolution failed while contacting YouTube'
    case 'connect_timeout':
      return 'Connection to YouTube timed out'
    case 'process_timeout':
      return 'Extraction timed out'
    case 'network_error':
      return 'Network error while contacting YouTube'
    case 'malformed_output':
      return 'yt-dlp returned unreadable output'
    case 'runtime_missing':
      return 'yt-dlp runtime is not installed'
    default:
      return 'Unexpected extraction error'
  }
}
