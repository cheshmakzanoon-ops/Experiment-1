/**
 * Byte-relaying stream proxy.
 *
 * Responsibilities:
 *   1. Resolve a direct, single-file upstream URL (googlevideo.com) via the
 *      stream cache or one centralized extraction,
 *   2. Fetch upstream with the client's Range forwarded verbatim, following
 *      redirects MANUALLY and re-validating every hop against the host
 *      allowlist (safeFetchMedia),
 *   3. Relay the upstream status/headers/body byte-for-byte without
 *      buffering the file in memory, honouring request cancellation,
 *   4. Serve honest HTTP semantics: malformed/unsupported ranges get 416
 *      (never a silent full download), a forwarded range that the upstream
 *      ignores with 200 is never represented as a 206, and a real YouTube
 *      429 never triggers a re-extraction storm (only a genuinely stale
 *      403 URL gets a single fresh extraction).
 */

import type { Context } from 'hono'
import { extractPlayableVideo } from './extractor.js'
import { YtDlpError, publicMessageFor, type YtErrorCategory } from '../ytdlp/errors.js'
import { OutboundFetchError, safeFetchMedia } from '../../utils/net.js'
import { assertSafeMediaUrl, UnsafeUrlError } from '../../utils/urlValidator.js'
import { forwardRangeHeader, parseRangeHeader, contentRangeForUnsatisfiable, resolveRange, formatContentRange } from '../../utils/range.js'
import { streamCache, type StreamCacheEntry, type StreamMeta } from '../../middleware/streamCache.js'
import { QueueFullError, QueueTimeoutError, createAbortError, isAbortError } from '../ytdlp/queue.js'
import { logger } from '../../utils/logger.js'
import { config } from '../../config.js'

export interface ResolvedStreamSource {
  url: string
  mimeType: string
  filesize?: number
  height?: number
  width?: number
  quality: string
  hasAudio: boolean
  hasVideo: boolean
  formatId: string
  /** Raw codec identifiers (R1/R2: tracked internally, never re-guessed). */
  vcodec?: string
  acodec?: string
  tbr?: number
  title: string
  author: string
  duration: number
  thumbnail?: string
  viewCount?: number
  /** True when the URL came from cache (allows one stale refresh). */
  fromCache: boolean
}

// ---------------------------------------------------------------------------
// Resolution (cache → extraction; single-flight lives in the runner)
// ---------------------------------------------------------------------------

/**
 * Extract + validate + cache ONE source. The bounded runner deduplicates
 * identical raw extractions (`extract:${videoId}` gate key); each resolver
 * caller independently awaits its own extraction here — no local flight
 * map to desynchronize from the runner's signal handling.
 */
async function extractSource(
  videoId: string,
  maxHeight: number,
  signal?: AbortSignal
): Promise<ResolvedStreamSource> {
  // Cancel before extraction (the runner rejects pre-aborted operations).
  const { info, stream } = await extractPlayableVideo(videoId, maxHeight, { signal })
  // Refuse to even cache a URL we would not relay.
  const safeUrl = assertSafeMediaUrl(stream.url)
  const source: ResolvedStreamSource = {
    url: safeUrl.toString(),
    mimeType: stream.mimeType,
    filesize: stream.filesize,
    height: stream.height,
    width: stream.width,
    quality: stream.quality,
    hasAudio: stream.hasAudio,
    hasVideo: stream.hasVideo,
    formatId: stream.formatId,
    vcodec: stream.vcodec,
    acodec: stream.acodec,
    tbr: stream.tbr,
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0,
    fromCache: false
  }
  // Cancel before writing the stream cache (never commit after abort).
  if (signal?.aborted) {
    throw createAbortError('Extraction cancelled')
  }
  streamCache.set(videoId, maxHeight, source)
  return source
}

function fromCacheEntry(videoId: string, maxHeight: number, entry: StreamCacheEntry): ResolvedStreamSource {
  return {
    url: entry.url,
    mimeType: entry.mimeType,
    filesize: entry.filesize,
    height: entry.height,
    width: entry.width,
    quality: entry.quality,
    hasAudio: entry.hasAudio,
    hasVideo: entry.hasVideo,
    formatId: entry.formatId,
    vcodec: entry.vcodec,
    acodec: entry.acodec,
    tbr: entry.tbr,
    title: entry.title,
    author: entry.author,
    duration: entry.duration,
    thumbnail: entry.thumbnail,
    viewCount: entry.viewCount,
    fromCache: true
  }
}

/** Resolve the proxiable stream (cache hit or one bounded extraction). */
export async function resolveStreamSource(
  videoId: string,
  maxHeight: number,
  forceRefresh = false,
  options: { signal?: AbortSignal } = {}
): Promise<ResolvedStreamSource> {
  if (!forceRefresh) {
    const cached = streamCache.get(videoId, maxHeight)
    if (cached) {
      logger.debug('stream cache hit', { videoId, maxHeight })
      return fromCacheEntry(videoId, maxHeight, cached)
    }
  }

  logger.debug('stream cache miss', { videoId, maxHeight, forceRefresh })
  // Each resolver caller awaits its own extraction; identical concurrent
  // raw extractions are single-flighted inside the runner by video id.
  return extractSource(videoId, maxHeight, options.signal)
}

// ---------------------------------------------------------------------------
// Upstream fetch (manual redirects, allowlist re-validated per hop)
// ---------------------------------------------------------------------------

const UPSTREAM_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.youtube.com/',
  Origin: 'https://www.youtube.com'
}

async function fetchUpstream(
  url: string,
  rangeHeader: string | undefined,
  signal: AbortSignal
): Promise<Response> {
  const headers: Record<string, string> = { ...UPSTREAM_HEADERS }
  if (rangeHeader) headers['Range'] = rangeHeader

  return safeFetchMedia(url, {
    headers,
    signal,
    timeoutMs: config.outbound.connectTimeoutMs
  })
}

// ---------------------------------------------------------------------------
// Read-timeout wrapper for stalled CDN bodies
// ---------------------------------------------------------------------------

const READ_TIMEOUT_MS = (): number => config.outbound.readTimeoutMs

function withReadTimeout(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const armTimeout = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    timeoutId = setTimeout(() => {
      controller.error(new Error('Upstream stalled: no data for a while'))
      void reader.cancel().catch(() => {})
    }, READ_TIMEOUT_MS())
    timeoutId.unref?.()
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      armTimeout(controller)
      try {
        const { done, value } = await reader.read()
        if (timeoutId) clearTimeout(timeoutId)
        timeoutId = null
        if (done) {
          controller.close()
          return
        }
        if (value) controller.enqueue(value)
      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId)
        timeoutId = null
        controller.error(error)
        void reader.cancel().catch(() => {})
      }
    },
    cancel(reason) {
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = null
      return reader.cancel(reason)
    }
  })
}

// ---------------------------------------------------------------------------
// Range policy for the client request
// ---------------------------------------------------------------------------

export function rejectMalformedRangeEarly(
  rawRange: string | undefined | null,
  knownTotal?: number
): { status: 416; contentRange: string } | null {
  const parse = parseRangeHeader(rawRange)
  if (parse.kind === 'absent' || parse.kind === 'valid') return null
  const total = knownTotal && knownTotal > 0 ? knownTotal : undefined
  return { status: 416, contentRange: contentRangeForUnsatisfiable(total) }
}

interface ClientRangeDecision {
  /** Forwarded header value (undefined = no range upstream). */
  forwarded: string | undefined
  /** Parsed raw range (for 200-relay policy). */
  parse: ReturnType<typeof parseRangeHeader>
  /** When known from the cached filesize. */
  totalSize?: number
}

/**
 * Decide what to forward for an already-validated range. Malformed ranges
 * never reach this point — rejectMalformedRangeEarly answers them before
 * any cache/extraction work — so only absent or valid specs are handled
 * here. A valid-but-unsatisfiable range (decidable only once a total is
 * known) is still answered locally with 416 before any upstream fetch.
 */
function decideClientRange(
  parse: ReturnType<typeof parseRangeHeader>,
  knownTotal: number | undefined
): { decision: ClientRangeDecision } | { error: { status: 416; contentRange: string } } {
  if (parse.kind === 'absent') {
    return { decision: { forwarded: undefined, parse } }
  }
  if (parse.kind === 'invalid') {
    // Unreachable from proxyVideoStream (rejectMalformedRangeEarly answers
    // invalid ranges first) — retained only to narrow the union; fail safe.
    const total = knownTotal && knownTotal > 0 ? knownTotal : undefined
    return { error: { status: 416, contentRange: contentRangeForUnsatisfiable(total) } }
  }

  // Valid spec: check satisfiability when we know the total.
  if (knownTotal !== undefined && knownTotal > 0) {
    const resolved = resolveRange(parse.spec, knownTotal)
    if (resolved.kind === 'unsatisfiable') {
      return { error: { status: 416, contentRange: contentRangeForUnsatisfiable(knownTotal) } }
    }
  }

  const forwarded = forwardRangeHeader(parse, knownTotal)
  return { decision: { forwarded, parse, totalSize: knownTotal } }
}

/** May a 200 (full-body) upstream response be relayed for this request? */
function upstream200IsUsable(parse: ReturnType<typeof parseRangeHeader>, forwarded: string | undefined): boolean {
  if (!forwarded || parse.kind !== 'valid') return true // no range sent, or full request
  if (parse.spec.type === 'interval' && parse.spec.start === 0) return true
  if (parse.spec.type === 'from' && parse.spec.start === 0) return true
  // suffix ranges and non-zero seeks must not be served as full bodies.
  return false
}

// ---------------------------------------------------------------------------
// Relay response builder
// ---------------------------------------------------------------------------

/** Upstream headers we are willing to forward. */
const RELAY_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'etag',
  'last-modified',
  'accept-ranges'
]

function buildRelayResponse(
  upstream: Response,
  fallbackMimeType: string,
  headOnly: boolean,
  statusOverride?: number,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers()
  for (const name of RELAY_HEADERS) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', fallbackMimeType || 'video/mp4')
  }
  headers.set('Accept-Ranges', 'bytes')
  // Private household media: never shared-cacheable, never transformable.
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Content-Type-Options', 'nosniff')
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    headers.set(name, value)
  }

  const status = statusOverride ?? upstream.status
  if (headOnly) {
    void upstream.body?.cancel().catch(() => {})
    return new Response(null, { status, headers })
  }
  if (!upstream.body) {
    return new Response(null, { status, headers })
  }

  return new Response(withReadTimeout(upstream.body), { status, headers })
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export interface StreamFailure {
  status: number
  code: string
  error: string
  retryAfterSeconds?: number
}

export function mapStreamFailure(error: unknown): StreamFailure {
  if (isAbortError(error)) {
    return { status: 499, code: 'CLIENT_ABORT', error: 'Request aborted' }
  }
  if (error instanceof QueueFullError) {
    return { status: 503, code: 'SERVER_BUSY', error: 'Server is busy — try again shortly', retryAfterSeconds: error.retryAfterSeconds }
  }
  if (error instanceof QueueTimeoutError) {
    return { status: 503, code: 'SERVER_BUSY', error: 'Server is busy — try again shortly', retryAfterSeconds: 5 }
  }
  if (error instanceof YtDlpError) {
    return {
      status: error.status,
      code: error.code,
      error: publicMessageFor(error.category),
      retryAfterSeconds: error.category === 'rate_limit' ? 30 : error.category === 'bot_detection' ? 60 : undefined
    }
  }
  if (error instanceof OutboundFetchError) {
    switch (error.kind) {
      case 'connect_timeout':
        return { status: 504, code: 'UPSTREAM_TIMEOUT', error: 'The media server timed out' }
      case 'dns':
      case 'connect_refused':
      case 'tls':
        return { status: 502, code: 'UPSTREAM_UNREACHABLE', error: 'The media server is unreachable' }
      case 'unsafe_url':
        return { status: 502, code: 'UNSAFE_UPSTREAM', error: 'Upstream URL rejected' }
      case 'aborted':
        return { status: 499, code: 'CLIENT_ABORT', error: 'Request aborted' }
      default:
        return { status: 502, code: 'UPSTREAM_ERROR', error: 'The media server returned an error' }
    }
  }
  if (error instanceof UnsafeUrlError) {
    return { status: 502, code: 'UNSAFE_UPSTREAM', error: 'Upstream URL rejected' }
  }
  return { status: 500, code: 'STREAM_ERROR', error: 'Internal stream error' }
}

// ---------------------------------------------------------------------------
// Main proxy
// ---------------------------------------------------------------------------

/**
 * Proxy a video stream request end-to-end and return the response Hono
 * should send. Throws (or returns a mapped error via `mapStreamFailure`)
 * for non-relayable conditions.
 */
export async function proxyVideoStream(
  c: Context,
  videoId: string,
  maxHeight: number
): Promise<Response> {
  const clientRange = c.req.header('range') || undefined
  const headOnly = c.req.raw.method === 'HEAD'
  const signal = c.req.raw.signal

  // Malformed/unsupported ranges are rejected BEFORE any cache lookup or
  // extraction work: junk requests must never burn a yt-dlp run.
  const earlyRejection = rejectMalformedRangeEarly(
    clientRange,
    streamCache.get(videoId, maxHeight)?.filesize
  )
  if (earlyRejection) {
    const headers: Record<string, string> = {
      'Content-Range': earlyRejection.contentRange,
      'Cache-Control': 'private, no-store'
    }
    if (headOnly) return new Response(null, { status: 416, headers })
    return c.json({ error: 'Range not satisfiable', code: 'RANGE_INVALID' }, 416, headers)
  }

  let source = await resolveStreamSource(videoId, maxHeight, false, { signal })

  // Decide the range policy BEFORE any upstream work. Unsatisfiable ranges
  // (only decidable once a total is known) are rejected locally with 416 —
  // never forwarded, never a silent full download. Malformed ranges were
  // already rejected above, before any cache/extraction work.
  const rangeDecision = decideClientRange(parseRangeHeader(clientRange), source.filesize)
  if ('error' in rangeDecision) {
    const { status, contentRange } = rangeDecision.error
    const headers: Record<string, string> = { 'Content-Range': contentRange, 'Cache-Control': 'private, no-store' }
    if (headOnly) {
      return new Response(null, { status: 416, headers })
    }
    return c.json({ error: 'Range not satisfiable', code: 'RANGE_INVALID' }, status as 416, headers)
  }
  const { forwarded, parse } = rangeDecision.decision

  const attempt = async (useFreshSource: boolean): Promise<Response> => {
    if (useFreshSource && source.fromCache) {
      streamCache.deleteVideo(videoId)
      source = await resolveStreamSource(videoId, maxHeight, true, { signal })
    }

    const upstream = await fetchUpstream(source.url, forwarded, signal)
    const status = upstream.status

    // Stale/revoked URL: a 403 on a cached URL gets ONE fresh extraction.
    // A 429 is a genuine rate limit and must NOT trigger more extraction.
    if (status === 403 && source.fromCache && !useFreshSource) {
      await upstream.body?.cancel().catch(() => {})
      logger.info('stream stale url 403; refreshing once', { videoId, maxHeight })
      return attempt(true)
    }

    if (status === 200 && forwarded && !upstream200IsUsable(parse, forwarded)) {
      // The upstream ignored our byte range and sent the full body. It must
      // NOT be presented as the requested partial content.
      await upstream.body?.cancel().catch(() => {})
      const failure = new OutboundFetchError('Upstream ignored the byte range (200 for a ranged request)', 'http_error', 200, false)
      const mapped = mapStreamFailure(failure)
      return c.json({ error: mapped.error, code: 'UPSTREAM_RANGE_IGNORED' }, 502, {
        'Cache-Control': 'private, no-store'
      })
    }

    if (status >= 500 || status === 403 || status === 429 || status === 404) {
      await upstream.body?.cancel().catch(() => {})
      if (status === 429) {
        return c.json(
          { error: 'Media server is rate-limiting (YouTube is busy)', code: 'YT_RATE_LIMITED' },
          429,
          { 'Cache-Control': 'private, no-store', 'Retry-After': '30' }
        )
      }
      if (status === 403) {
        return c.json(
          { error: 'Media server refused the request — egress may be blocked', code: 'YT_EGRESS_BLOCKED' },
          429,
          { 'Cache-Control': 'private, no-store', 'Retry-After': '60' }
        )
      }
      return c.json({ error: 'Upstream media error', code: 'UPSTREAM_ERROR' }, 502, {
        'Cache-Control': 'private, no-store'
      })
    }

    return buildRelayResponse(upstream, source.mimeType, headOnly)
  }

  return attempt(false)
}

// ---------------------------------------------------------------------------
// Probe (explicit diagnostics only — never part of normal playback)
// ---------------------------------------------------------------------------

export interface ProbeResult {
  available: boolean
  videoId: string
  quality?: string
  mimeType?: string
  filesize?: number
  status?: number
  error?: string
  code?: string
}

export async function probeVideoStream(
  videoId: string,
  maxHeight: number,
  options: { signal?: AbortSignal } = {}
): Promise<ProbeResult> {
  try {
    const source = await resolveStreamSource(videoId, maxHeight, false, options)
    const upstream = await fetchUpstream(source.url, 'bytes=0-1023', options.signal ?? new AbortController().signal)
    const ok = (upstream.status >= 200 && upstream.status < 300) || upstream.status === 206
    await upstream.body?.cancel().catch(() => {})
    if (ok) {
      return {
        available: true,
        videoId,
        quality: source.quality,
        mimeType: source.mimeType,
        filesize: source.filesize,
        status: upstream.status
      }
    }
    return {
      available: false,
      videoId,
      status: upstream.status,
      error: `Upstream returned HTTP ${upstream.status}`
    }
  } catch (error) {
    const failure = mapStreamFailure(error)
    return { available: false, videoId, error: failure.error, code: failure.code }
  }
}

export type { YtErrorCategory }
