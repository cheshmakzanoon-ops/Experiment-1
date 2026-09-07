import { Hono } from 'hono'
import { searchForVideos } from '../services/youtube/searchService.js'
import { parseParam } from '../utils/params.js'
import { YtDlpError } from '../services/ytdlp/errors.js'
import { publicMessageFor } from '../services/ytdlp/errors.js'
import { QueueFullError, QueueTimeoutError } from '../services/ytdlp/queue.js'

const searchRoutes = new Hono()

const MAX_QUERY_LENGTH = 100
const MAX_RESULTS = 20

// GET /api/search?q=…&max=…
searchRoutes.get('/search', async (c) => {
  const rawQuery = c.req.query('q')
  if (!rawQuery || rawQuery.trim().length === 0) {
    return c.json({ error: 'Query parameter "q" is required', code: 'QUERY_REQUIRED' }, 400)
  }
  const query = rawQuery.trim()
  if (query.length > MAX_QUERY_LENGTH) {
    return c.json({ error: 'Query too long (max 100 characters)', code: 'QUERY_TOO_LONG' }, 400)
  }

  const max = parseParam(c.req.query('max'), 12, 1, MAX_RESULTS)
  if (max.error) {
    return c.json({ error: `max must be an integer between 1 and ${MAX_RESULTS}`, code: 'INVALID_MAX' }, 400)
  }

  try {
    const results = await searchForVideos(query, max.value, { signal: c.req.raw.signal })
    return c.json({
      query,
      results,
      total: results.length
    })
  } catch (error) {
    if (error instanceof QueueFullError || error instanceof QueueTimeoutError) {
      return c.json({ error: 'Server is busy — try again shortly', code: 'SERVER_BUSY' }, 503, { 'Retry-After': '5' })
    }
    if (error instanceof YtDlpError) {
      return c.json(
        { error: publicMessageFor(error.category), code: error.code },
        error.status as 400 | 403 | 404 | 429 | 500 | 501 | 502 | 503 | 504
      )
    }
    return c.json({ error: 'Search failed', code: 'SEARCH_ERROR' }, 500)
  }
})

export { searchRoutes }
