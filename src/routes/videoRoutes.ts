import { Hono } from 'hono'
import { extractVideoInfo } from '../services/youtube/extractor.js'
import { SUPPORTED_QUALITIES } from '../services/youtube/extractor.js'
import { isValidVideoId } from '../utils/urlValidator.js'
import { memoryCache } from '../services/cache/memoryCache.js'
import { streamCache } from '../middleware/streamCache.js'
import { safeFetchMedia } from '../utils/net.js'
import { YtDlpError } from '../services/ytdlp/errors.js'
import { publicMessageFor } from '../services/ytdlp/errors.js'
import type { VideoMetadata } from '../types/video.js'
import { QueueFullError, QueueTimeoutError } from '../services/ytdlp/queue.js'

const videoRoutes = new Hono()
const VALID_QUALITIES = SUPPORTED_QUALITIES as readonly string[]

/** What the /video endpoint may return: NEVER the direct googlevideo URL. */
interface PublicVideoInfo {
  id: string
  title: string
  description: string
  duration: number
  thumbnail: string
  author: string
  authorId: string
  viewCount: number
  uploadDate: string
  /** Our proxy URL (relative, same-origin). */
  streamUrl: string
  // ---- R2 additive playback-truth metadata (no signed upstream URLs) ----
  requestedQuality: string
  actualQuality: string
  hasAudio: boolean
  hasVideo: boolean
  mimeType: string
  codecs: { video?: string; audio?: string }
  availableQualities: Array<{ height?: number; label: string; mimeType: string; formatId?: string }>
  selectionReason: string
}

function toPublicVideoInfo(videoId: string, quality: string, v: VideoMetadata): PublicVideoInfo {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    duration: v.duration,
    thumbnail: `/api/video/${videoId}/thumbnail`,
    author: v.author,
    authorId: v.authorId,
    viewCount: v.viewCount,
    uploadDate: v.uploadDate,
    streamUrl: `/api/stream/${videoId}?quality=${quality}`,
    requestedQuality: v.requestedQuality ?? `${quality}p`,
    actualQuality: v.actualQuality ?? v.formats?.[0]?.quality ?? `${quality}p`,
    hasAudio: v.hasAudio ?? false,
    hasVideo: v.hasVideo ?? false,
    mimeType: v.mimeType ?? v.formats?.[0]?.mimeType ?? 'video/mp4',
    codecs: v.codecs ?? { video: v.formats?.[0]?.vcodec, audio: v.formats?.[0]?.acodec },
    availableQualities: v.availableQualities ?? [],
    selectionReason: v.selectionReason ?? 'extraction'
  }
}

/**
 * Prime the stream cache with the extraction result so the next
 * /api/stream request is a cache hit (one yt-dlp run instead of two).
 */
function seedStreamCache(videoId: string, maxHeight: number, v: VideoMetadata): void {
  const format = v.formats?.[0]
  if (!format?.url) return
  streamCache.set(videoId, maxHeight, {
    url: format.url,
    mimeType: format.mimeType,
    filesize: format.filesize,
    height: format.height,
    width: format.width,
    quality: format.quality,
    hasAudio: format.hasAudio,
    hasVideo: format.hasVideo,
    formatId: format.formatId || format.quality,
    vcodec: format.vcodec,
    acodec: format.acodec,
    title: v.title,
    author: v.author,
    duration: v.duration,
    thumbnail: v.thumbnail,
    viewCount: v.viewCount
  })
}

// Thumbnails are small (tens of KB); 2 MiB is a generous cap that still
// accepts every real mqdefault/sddefault image. An upstream that streams
// past this bound is cancelled — never buffered.
const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

/**
 * Bounded read (A04): cap the upstream body read, cancel the remainder, and
 * fail with a controlled 502 instead of buffering an unbounded network
 * stream. A declared Content-Length above the cap is refused before any
 * byte is read.
 */
async function readBoundedThumbnail(
  upstream: Response,
  limitBytes: number
): Promise<{ ok: true; bytes: Buffer } | { ok: false; reason: 'too_large' | 'read_error' }> {
  const declared = upstream.headers.get('content-length')
  if (declared !== null && declared !== '') {
    const size = Number(declared)
    if (Number.isFinite(size) && size > limitBytes) {
      await upstream.body?.cancel().catch(() => {})
      return { ok: false, reason: 'too_large' }
    }
  }

  if (!upstream.body) return { ok: false, reason: 'read_error' }

  const reader = upstream.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > limitBytes) {
        await reader.cancel('thumbnail body limit exceeded').catch(() => {})
        return { ok: false, reason: 'too_large' }
      }
      chunks.push(value)
    }
  } catch {
    await reader.cancel().catch(() => {})
    return { ok: false, reason: 'read_error' }
  }
  return { ok: true, bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) }
}

function metadataFailure(error: unknown): { status: number; body: Record<string, string> } {
  if (error instanceof QueueFullError || error instanceof QueueTimeoutError) {
    return { status: 503, body: { error: 'Server is busy — try again shortly', code: 'SERVER_BUSY' } }
  }
  if (error instanceof YtDlpError) {
    return {
      status: error.status,
      body: { error: publicMessageFor(error.category), code: error.code }
    }
  }
  return { status: 500, body: { error: 'Failed to extract video', code: 'INTERNAL' } }
}

// GET /api/video/:id — sanitized metadata for the watch page.
videoRoutes.get('/video/:id', async (c) => {
  const videoId = c.req.param('id')
  const quality = c.req.query('quality') || '240'

  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID', code: 'INVALID_ID' }, 400)
  }
  if (!VALID_QUALITIES.includes(quality)) {
    return c.json({ error: `Invalid quality. Must be one of: ${VALID_QUALITIES.join(', ')}`, code: 'INVALID_QUALITY' }, 400)
  }

  const cacheKey = `video:${videoId}:${quality}`
  const cached = memoryCache.get<PublicVideoInfo>(cacheKey)
  if (cached) return c.json(cached)

  try {
    const qualityInt = parseInt(quality, 10)
    const videoInfo = await extractVideoInfo(videoId, qualityInt, { signal: c.req.raw.signal })

    seedStreamCache(videoId, qualityInt, videoInfo)

    const response = toPublicVideoInfo(videoId, quality, videoInfo)
    memoryCache.set(cacheKey, response, 2 * 60 * 60 * 1000)
    return c.json(response)
  } catch (error) {
    const failure = metadataFailure(error)
    return c.json(failure.body, failure.status as 400 | 403 | 404 | 429 | 500 | 501 | 502 | 503 | 504)
  }
})

// GET /api/video/:id/thumbnail — proxied i.ytimg.com images. Session cookie
// authenticates; <img> tags carry cookies automatically. Served via the same
// safe outbound transport as streams (manual redirects, host allowlist).
videoRoutes.get('/video/:id/thumbnail', async (c) => {
  const videoId = c.req.param('id')
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  const cacheKey = `thumbnail:${videoId}:mqdefault`
  const cached = memoryCache.get<Buffer>(cacheKey)
  if (cached) {
    return serveThumbnail(c, cached)
  }

  try {
    const upstream = await safeFetchMedia(
      `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      { timeoutMs: 10_000, signal: c.req.raw.signal }
    )
    if (!upstream.ok) {
      return c.json({ error: 'Thumbnail unavailable from upstream', code: 'UPSTREAM_ERROR' }, 502)
    }
    const bounded = await readBoundedThumbnail(upstream, THUMBNAIL_MAX_BYTES)
    if (!bounded.ok) {
      return c.json({ error: 'Thumbnail unavailable from upstream', code: 'UPSTREAM_ERROR' }, 502)
    }
    memoryCache.set(cacheKey, bounded.bytes, 86_400_000)
    return serveThumbnail(c, bounded.bytes)
  } catch {
    return c.json({ error: 'Failed to fetch thumbnail', code: 'UPSTREAM_ERROR' }, 502)
  }
})

function serveThumbnail(c: import('hono').Context, bytes: Buffer): Response {
  return c.body(Uint8Array.from(bytes), 200, {
    'Content-Type': 'image/jpeg',
    // Private caching: the browser + service worker cache; shared caches
    // must not (thumbnail requests are cookie-authenticated).
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff'
  })
}

export { videoRoutes }
