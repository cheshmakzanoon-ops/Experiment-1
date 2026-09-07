import { Hono } from 'hono'
import { isValidVideoId } from '../utils/urlValidator.js'
import { SUPPORTED_QUALITIES, YtDlpError } from '../utils/ytDlp.js'
import { proxyVideoStream, probeVideoStream } from '../services/youtube/streamProxy.js'
import { streamCache } from '../middleware/streamCache.js'

const streamRoutes = new Hono()

const QUALITY_PARAM = SUPPORTED_QUALITIES.join(', ')

function qualityValue(raw: string | undefined): number | null {
  const quality = raw || '240'
  if (!(SUPPORTED_QUALITIES as readonly string[]).includes(quality)) return null
  return parseInt(quality, 10)
}

/** Map proxy/extraction failures onto a JSON error body. */
function errorBody(error: unknown) {
  const yt = error instanceof YtDlpError ? error : null
  const status = yt?.code && yt.code >= 400 && yt.code <= 599 ? yt.code : 500
  const labels: Record<number, string> = {
    400: 'INVALID_ID',
    404: 'NOT_FOUND',
    403: 'FORBIDDEN',
    429: 'RATE_LIMITED',
    501: 'NOT_SUPPORTED',
    502: 'UPSTREAM_ERROR',
    504: 'TIMEOUT'
  }
  return {
    status,
    body: {
      error: yt?.message || 'Internal stream error',
      code: labels[status] || 'STREAM_ERROR'
    }
  }
}

// --- GET /api/stream/stats -------------------------------------------------
// Cache statistics (registered before /stream/:id so "stats" is not parsed
// as a video id).
streamRoutes.get('/stream/stats', (c) => {
  return c.json({
    ...streamCache.getStats(),
    timestamp: new Date().toISOString()
  })
})

// --- GET /api/stream/:id/probe ---------------------------------------------
// Lightweight availability check (extracts if needed, requests 1 KB upstream).
streamRoutes.get('/stream/:id/probe', async (c) => {
  const videoId = c.req.param('id')
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID' }, 400)
  }

  const maxHeight = qualityValue(c.req.query('quality'))
  if (maxHeight === null) {
    return c.json({ error: `Invalid quality. Must be one of: ${QUALITY_PARAM}` }, 400)
  }

  const result = await probeVideoStream(videoId, maxHeight)
  return c.json(result)
})

// --- GET /api/stream/:id ----------------------------------------------------
// The byte-relaying streaming proxy. Range requests pass through to the
// upstream, so a seek produces 206 Partial Content with a Content-Range.
// HEAD is served by Hono from this GET handler with the body dropped.
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
    const { status, body } = errorBody(error)
    return c.json(body, status as 400 | 403 | 404 | 429 | 500 | 501 | 502 | 504)
  }
})

export { streamRoutes }
