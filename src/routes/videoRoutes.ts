import { Hono, type Context } from 'hono'
import { extractVideoInfo, SUPPORTED_QUALITIES } from '../utils/ytDlp.js'
import type { VideoMetadata } from '../types/video.js'
import { memoryCache } from '../services/cache/memoryCache.js'
import { streamCache } from '../middleware/streamCache.js'
import { isValidVideoId } from '../utils/urlValidator.js'

const videoRoutes = new Hono()
const VALID_QUALITIES = SUPPORTED_QUALITIES as readonly string[]

/** What the /video endpoint may return: never the direct googlevideo URL. */
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
  streamUrl: string
}

function toPublicVideoInfo(videoId: string, quality: string, v: VideoMetadata): PublicVideoInfo {
  return {
    id: v.id,
    title: v.title,
    description: v.description,
    duration: v.duration,
    // Thumbnail rewritten to our proxy so it loads even where i.ytimg.com is blocked.
    thumbnail: `/api/video/${videoId}/thumbnail`,
    author: v.author,
    authorId: v.authorId,
    viewCount: v.viewCount,
    uploadDate: v.uploadDate,
    // Our proxy URL — not YouTube's direct media URL.
    streamUrl: `/api/stream/${videoId}?quality=${quality}`
  }
}

/**
 * Prime the stream cache with the extraction result. This makes the very
 * next /api/stream request (the player's probe) a cache hit — the watch
 * page does not pay for two yt-dlp runs back-to-back.
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
    title: v.title,
    author: v.author,
    duration: v.duration,
    thumbnail: v.thumbnail,
    viewCount: v.viewCount
  })
}

// GET /api/video/:id
videoRoutes.get('/video/:id', async (c) => {
  const videoId = c.req.param('id')
  const quality = c.req.query('quality') || '240'

  // Validate video ID (YouTube IDs are 11 characters)
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  // Validate quality
  if (!VALID_QUALITIES.includes(quality)) {
    return c.json({ error: `Invalid quality. Must be one of: ${VALID_QUALITIES.join(', ')}` }, 400)
  }

  const cacheKey = `video:${videoId}:${quality}`
  const cached = memoryCache.get<PublicVideoInfo>(cacheKey)

  if (cached) {
    return c.json(cached)
  }

  try {
    const qualityInt = parseInt(quality, 10)

    // Extract video info (may hit its own internal retry/backoff loop).
    const videoInfo = await extractVideoInfo(videoId, qualityInt)

    // Remember the direct URL for the streaming proxy.
    seedStreamCache(videoId, qualityInt, videoInfo)

    // Cache the sanitized payload (2 hours) — never the raw info dict.
    const response = toPublicVideoInfo(videoId, quality, videoInfo)
    memoryCache.set(cacheKey, response, 7200000)

    return c.json(response)
  } catch (error: any) {
    console.error(`Failed to get video ${videoId}:`, error)

    if (error.code === 404) {
      return c.json({ error: 'Video not found' }, 404)
    }
    if (error.code === 429) {
      return c.json({ error: 'YouTube is blocking requests. Try again later.' }, 429)
    }
    if (error.code === 403) {
      return c.json({ error: 'This video is private or restricted' }, 403)
    }
    if (error.code === 501) {
      return c.json({ error: 'Live streams are not supported yet' }, 501)
    }

    return c.json({
      error: 'Failed to extract video',
      message: error.message
    }, 500)
  }
})

function serveThumbnail(c: Context, bytes: Buffer, contentType: string) {
  // Buffer is ArrayBufferLike-typed in @types/node; Hono's body wants
  // Uint8Array<ArrayBuffer>, so copy into a fresh ArrayBuffer first.
  return c.body(Uint8Array.from(bytes), 200, {
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=86400',
    'Access-Control-Allow-Origin': '*'
  })
}

// GET /api/video/:id/thumbnail
// Proxies thumbnails from i.ytimg.com through the server so images load
// even where YouTube's image CDN is blocked. Always serves the
// mqdefault (320x180) size for now.
videoRoutes.get('/video/:id/thumbnail', async (c) => {
  const videoId = c.req.param('id')
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  const cacheKey = `thumbnail:${videoId}:mqdefault`
  const cached = memoryCache.get<Buffer>(cacheKey)

  if (cached) {
    return serveThumbnail(c, cached, 'image/jpeg')
  }

  try {
    const upstream = await fetch(`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`)
    if (!upstream.ok) {
      return c.json({ error: 'Thumbnail unavailable from upstream' }, 502)
    }
    const buffer = Buffer.from(await upstream.arrayBuffer())
    memoryCache.set(cacheKey, buffer, 86400000) // cache for 24h

    return serveThumbnail(c, buffer, upstream.headers.get('content-type') || 'image/jpeg')
  } catch {
    return c.json({ error: 'Failed to fetch thumbnail' }, 502)
  }
})

export { videoRoutes }
