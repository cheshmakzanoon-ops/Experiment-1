import type { Context } from 'hono'
import { extractPlayableVideo, YtDlpError, type SelectedStream } from '../../utils/ytDlp.js'
import { assertSafeStreamUrl } from '../../utils/urlValidator.js'
import { buildRangeHeader, isSuccessStatus } from '../../utils/httpUtils.js'
import { streamCache, type StreamMeta } from '../../middleware/streamCache.js'

/**
 * Byte-relaying stream proxy.
 *
 * Responsibilities:
 *   1. Resolve a direct, single-file upstream URL (googlevideo.com) via the
 *      stream cache or a yt-dlp extraction.
 *   2. Fetch the upstream with the client's Range header forwarded verbatim.
 *   3. Relay the upstream status/headers/body straight back to the client,
 *      byte-for-byte, without buffering the file in memory.
 *
 * The client's phone only ever talks to this server — Range requests (206
 * Partial Content) pass through so seeking works, and nothing is ever
 * redirected to googlevideo.com.
 */

// Realistic desktop browser headers so YouTube's CDN serves us normally.
const UPSTREAM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://www.youtube.com/',
  Origin: 'https://www.youtube.com'
}

/** How long we wait for the upstream to send response headers. */
const UPSTREAM_HEADER_TIMEOUT_MS = 30_000

/** Upstream statuses that suggest the cached URL was revoked/blocked. */
function isBlockingStatus(status: number): boolean {
  return status === 403 || status === 429
}

export interface ResolvedStreamSource extends SelectedStream, StreamMeta {}

/**
 * Resolve the proxiable stream for a video, using the stream cache unless a
 * forced refresh is requested. Never returns a URL we are not willing to
 * relay: `assertSafeStreamUrl` restricts upstreams to YouTube's media hosts.
 */
export async function resolveStreamSource(
  videoId: string,
  maxHeight: number,
  forceRefresh: boolean = false
): Promise<ResolvedStreamSource> {
  if (!forceRefresh) {
    const cached = streamCache.get(videoId, maxHeight)
    if (cached) {
      console.log(`[stream] Cache hit for ${videoId}@${maxHeight}p (${cached.formatId})`)
      const safeUrl = assertSafeStreamUrl(cached.url)
      const {
        mimeType, filesize, height, width, quality,
        hasAudio, hasVideo, formatId,
        title, author, duration, thumbnail, viewCount
      } = cached
      return {
        url: safeUrl.toString(),
        mimeType, filesize, height, width, quality,
        hasAudio, hasVideo, formatId,
        title, author, duration, thumbnail, viewCount
      }
    }
  }

  console.log(`[stream] Cache miss for ${videoId}@${maxHeight}p — extracting via yt-dlp...`)

  const { info, stream } = await extractPlayableVideo(videoId, maxHeight)
  const safeUrl = assertSafeStreamUrl(stream.url)

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
    title: info.title || '',
    author: info.uploader || info.channel || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
    viewCount: info.view_count || 0
  }

  streamCache.set(videoId, maxHeight, source)
  return source
}

/**
 * Fetch the upstream media with the client's Range forwarded. Throws a
 * YtDlpError with an HTTP-ish code when the upstream refuses the request.
 */
async function fetchUpstream(
  url: string,
  clientRange: string | undefined,
  signal: AbortSignal
): Promise<Response> {
  const rangeHeader = buildRangeHeader(clientRange)
  const headers: Record<string, string> = { ...UPSTREAM_HEADERS }
  if (rangeHeader) headers['Range'] = rangeHeader

  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, UPSTREAM_HEADER_TIMEOUT_MS)
  signal.addEventListener('abort', abort, { once: true })

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    })
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    throw new YtDlpError(
      aborted ? 'Upstream timed out while connecting' : 'Failed to reach the media server',
      aborted ? 504 : 502,
      !aborted,
      error
    )
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }

  if (!isSuccessStatus(upstream.status) && upstream.status !== 206) {
    const status = upstream.status
    await upstream.body?.cancel().catch(() => {})
    if (isBlockingStatus(status)) {
      throw new YtDlpError(
        'Media server refused the request (possibly rate-limited)',
        429,
        true
      )
    }
    throw new YtDlpError(`Media server returned HTTP ${status}`, 502, false)
  }

  return upstream
}

/** Upstream headers we are willing to forward to the client. */
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
  headOnly: boolean
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
  headers.set('Cache-Control', 'public, max-age=3600')
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

  if (headOnly) {
    // HEAD preflight: relay the headers but don't stream the body.
    void upstream.body?.cancel().catch(() => {})
    return new Response(null, { status: upstream.status, headers })
  }

  return new Response(upstream.body, { status: upstream.status, headers })
}

/**
 * Proxy a video stream request end-to-end and return the response Hono
 * should send to the client.
 *
 * Throws YtDlpError on extraction/fetch failures so routes can map it to a
 * JSON error body.
 */
export async function proxyVideoStream(
  c: Context,
  videoId: string,
  maxHeight: number
): Promise<Response> {
  const clientRange = c.req.header('range') || undefined
  // Hono serves HEAD by re-dispatching the GET handler, so the effective
  // method is GET here — check the raw request to detect a HEAD preflight.
  const headOnly = c.req.raw.method === 'HEAD'

  let source = await resolveStreamSource(videoId, maxHeight)
  let upstream: Response

  try {
    upstream = await fetchUpstream(source.url, clientRange, c.req.raw.signal)
  } catch (error) {
    // A 429/403 from the media CDN usually means the cached URL expired or
    // was revoked — drop the cached entry, re-extract once and retry.
    if (error instanceof YtDlpError && error.code === 429) {
      console.log(`[stream] Upstream blocked ${videoId}; clearing cache and re-extracting...`)
      streamCache.deleteVideo(videoId)
      source = await resolveStreamSource(videoId, maxHeight, true)
      upstream = await fetchUpstream(source.url, clientRange, c.req.raw.signal)
    } else {
      throw error
    }
  }

  return buildRelayResponse(upstream, source.mimeType, headOnly)
}

export interface ProbeResult {
  available: boolean
  videoId: string
  quality?: string
  mimeType?: string
  filesize?: number
  error?: string
}

/**
 * Cheap availability probe: resolves the stream (cache or extraction) and
 * asks the upstream for the first 1 KB. Used by /api/stream/:id/probe.
 */
export async function probeVideoStream(
  videoId: string,
  maxHeight: number
): Promise<ProbeResult> {
  try {
    const source = await resolveStreamSource(videoId, maxHeight)
    const probe = await fetch(source.url, {
      method: 'GET',
      headers: {
        ...UPSTREAM_HEADERS,
        Range: 'bytes=0-1023'
      }
    })

    if (probe.body) {
      await probe.body.cancel().catch(() => {})
    }

    if (isSuccessStatus(probe.status) || probe.status === 206) {
      return {
        available: true,
        videoId,
        quality: source.quality,
        mimeType: source.mimeType,
        filesize: source.filesize
      }
    }

    return {
      available: false,
      videoId,
      error: `Upstream returned HTTP ${probe.status}`
    }
  } catch (error) {
    return {
      available: false,
      videoId,
      error: error instanceof Error ? error.message : 'Unknown probe error'
    }
  }
}
