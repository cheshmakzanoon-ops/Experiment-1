import { Hono } from 'hono'
import { getHomeFeed, getTrendingForCategory, getCategories } from '../services/youtube/trendingService.js'
import { parseParam } from '../utils/params.js'
import { YtDlpError } from '../services/ytdlp/errors.js'
import { publicMessageFor } from '../services/ytdlp/errors.js'
import { QueueFullError, QueueTimeoutError } from '../services/ytdlp/queue.js'
import { staleCache } from '../services/cache/staleCache.js'

const feedRoutes = new Hono()

const MAX_LIMIT = 24
const MAX_PAGE = 50 // bounded; real availability is governed by batch state

function pageParams(c: { req: { query: (k: string) => string | undefined } }): { error: boolean; page: number; limit: number; code: string } {
  const page = parseParam(c.req.query('page'), 1, 1, MAX_PAGE)
  const limit = parseParam(c.req.query('limit'), 12, 1, MAX_LIMIT)
  if (page.error || limit.error) {
    return {
      error: true,
      page: 0,
      limit: 0,
      code: page.error
        ? `page must be an integer between 1 and ${MAX_PAGE}`
        : `limit must be an integer between 1 and ${MAX_LIMIT}`
    }
  }
  return { error: false, page: page.value, limit: limit.value, code: '' }
}

function streamUrlFor(id: string): string {
  return `/api/stream/${id}?quality=240`
}

function failureBody(error: unknown): { status: number; body: Record<string, string> } {
  if (error instanceof QueueFullError || error instanceof QueueTimeoutError) {
    return { status: 503, body: { error: 'Server is busy — try again shortly', code: 'SERVER_BUSY' } }
  }
  if (error instanceof YtDlpError) {
    return {
      status: error.status,
      body: { error: publicMessageFor(error.category), code: error.code }
    }
  }
  if (error instanceof Error && error.message === 'Invalid category') {
    return { status: 400, body: { error: 'Invalid category ID', code: 'INVALID_CATEGORY' } }
  }
  return { status: 500, body: { error: 'Failed to load feed', code: 'FEED_ERROR' } }
}

// --- GET /api/feed/home -----------------------------------------------------
feedRoutes.get('/feed/home', async (c) => {
  const parsed = pageParams(c)
  if (parsed.error) {
    return c.json({ error: parsed.code, code: 'INVALID_PAGINATION' }, 400)
  }

  try {
    const result = await getHomeFeed(parsed.page, parsed.limit, { signal: c.req.raw.signal })
    return c.json({
      page: parsed.page,
      limit: parsed.limit,
      total: result.videos.length,
      hasMore: result.hasMore,
      videos: result.videos.map((v) => ({ ...v, streamUrl: streamUrlFor(v.id) }))
    })
  } catch (error) {
    const failure = failureBody(error)
    return c.json(failure.body, failure.status as 400 | 403 | 404 | 429 | 500 | 501 | 502 | 503 | 504)
  }
})

// --- GET /api/feed/category/:categoryId -------------------------------------
feedRoutes.get('/feed/category/:categoryId', async (c) => {
  const categoryId = c.req.param('categoryId')
  const parsed = pageParams(c)
  if (parsed.error) {
    return c.json({ error: parsed.code, code: 'INVALID_PAGINATION' }, 400)
  }

  try {
    const result = await getTrendingForCategory(categoryId, parsed.page, parsed.limit, { signal: c.req.raw.signal })
    return c.json({
      categoryId,
      page: parsed.page,
      limit: parsed.limit,
      total: result.videos.length,
      hasMore: result.hasMore,
      videos: result.videos.map((v) => ({ ...v, streamUrl: streamUrlFor(v.id) }))
    })
  } catch (error) {
    const failure = failureBody(error)
    return c.json(failure.body, failure.status as 400 | 403 | 404 | 429 | 500 | 501 | 502 | 503 | 504)
  }
})

// --- GET /api/feed/categories ----------------------------------------------
feedRoutes.get('/feed/categories', (c) => {
  const categories = getCategories()
  return c.json({
    categories: categories.map((cat) => ({ id: cat.id, nameFa: cat.nameFa, nameEn: cat.nameEn }))
  })
})

// --- GET /api/feed/stats ----------------------------------------------------
feedRoutes.get('/feed/stats', (c) => {
  return c.json({
    cacheSize: staleCache.size(),
    timestamp: new Date().toISOString()
  })
})

export { feedRoutes }
