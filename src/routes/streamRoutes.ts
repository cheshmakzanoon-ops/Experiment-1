import { Hono } from 'hono'
import { isValidVideoId } from '../utils/urlValidator.js'
import { SUPPORTED_QUALITIES } from '../services/youtube/extractor.js'
import { proxyVideoStream, probeVideoStream, mapStreamFailure } from '../services/youtube/streamProxy.js'
import { streamCache } from '../middleware/streamCache.js'

const streamRoutes = new Hono()

const QUALITY_PARAM = SUPPORTED_QUALITIES.join(', ')

function qualityValue(raw: string | undefined): number | null {
  const quality = raw || '240'
  if (!(SUPPORTED_QUALITIES as readonly string[]).includes(quality)) return null
  return parseInt(quality, 10)
}

// --- GET /api/stream/stats -------------------------------------------------
// Cache statistics — protected (session) and cheap.
streamRoutes.get('/stream/stats', (c) => {
  const stats = streamCache.getStats()
  return c.json({
    ...stats,
    // Expose only what the household operator needs to see.
    timestamp: new Date().toISOString()
  })
})

// --- GET /api/stream/:id/probe ---------------------------------------------
// Explicit availability probe (used by diagnostics only; normal playback
// never performs a probe round-trip).
streamRoutes.get('/stream/:id/probe', async (c) => {
  const videoId = c.req.param('id')
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  const maxHeight = qualityValue(c.req.query('quality'))
  if (maxHeight === null) {
    return c.json({ error: `Invalid quality. Must be one of: ${QUALITY_PARAM}` }, 400)
  }

  const result = await probeVideoStream(videoId, maxHeight, { signal: c.req.raw.signal })
  return c.json(result)
})

// --- GET /api/stream/:id ----------------------------------------------------
// The byte-relaying streaming proxy. Session cookie authenticates; the
// client's Range header is forwarded verbatim and relayed 206 semantics
// preserved. HEAD is served from this GET handler with the body dropped.
streamRoutes.get('/stream/:id', async (c) => {
  const videoId = c.req.param('id')

  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  const maxHeight = qualityValue(c.req.query('quality'))
  if (maxHeight === null) {
    return c.json({ error: `Invalid quality. Must be one of: ${QUALITY_PARAM}` }, 400)
  }

  try {
    const response = await proxyVideoStream(c, videoId, maxHeight)
    return response
  } catch (error) {
    const failure = mapStreamFailure(error)
    if (failure.status === 499) {
      // Client disconnected — nothing to send.
      return new Response(null, { status: 499 })
    }
    return c.json(
      { error: failure.error, code: failure.code },
      failure.status as 400 | 403 | 404 | 416 | 429 | 500 | 501 | 502 | 503 | 504,
      failure.retryAfterSeconds ? { 'Retry-After': String(failure.retryAfterSeconds) } : undefined
    )
  }
})

export { streamRoutes }
