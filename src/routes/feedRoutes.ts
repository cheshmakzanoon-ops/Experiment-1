import { Hono } from 'hono'
import {
  getTrendingForCategory,
  getHomeFeed,
  getCategories,
  feedCache
} from '../services/youtube/trendingService.js'

const feedRoutes = new Hono()

// --- GET /api/feed/home -----------------------------------------------------
// Mixed home feed (a variety of categories, like YouTube's recommendations).
feedRoutes.get('/feed/home', async (c) => {
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = parseInt(c.req.query('limit') || '12', 10)

  if (page < 1 || page > 20) {
    return c.json({ error: 'Page must be between 1 and 20' }, 400)
  }
  if (limit < 1 || limit > 24) {
    return c.json({ error: 'Limit must be between 1 and 24' }, 400)
  }

  try {
    const videos = await getHomeFeed(page, limit)

    return c.json({
      page,
      limit,
      total: videos.length,
      hasMore: videos.length === limit,
      videos: videos.map((v) => ({
        ...v,
        streamUrl: `/api/stream/${v.id}?quality=240`
      }))
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[feed] Home feed failed:', error)
    return c.json(
      {
        error: 'Failed to load home feed',
        code: 'FEED_ERROR',
        message
      },
      500
    )
  }
})

// --- GET /api/feed/category/:categoryId -------------------------------------
// Category-specific feed.
feedRoutes.get('/feed/category/:categoryId', async (c) => {
  const categoryId = c.req.param('categoryId')
  const page = parseInt(c.req.query('page') || '1', 10)
  const limit = parseInt(c.req.query('limit') || '12', 10)

  if (page < 1 || page > 10) {
    return c.json({ error: 'Page must be between 1 and 10' }, 400)
  }
  if (limit < 1 || limit > 24) {
    return c.json({ error: 'Limit must be between 1 and 24' }, 400)
  }

  try {
    const videos = await getTrendingForCategory(categoryId, page, limit)

    return c.json({
      categoryId,
      page,
      limit,
      total: videos.length,
      hasMore: videos.length === limit,
      videos: videos.map((v) => ({
        ...v,
        streamUrl: `/api/stream/${v.id}?quality=240`
      }))
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid category')) {
      return c.json({ error: 'Invalid category ID' }, 400)
    }

    const message = error instanceof Error ? error.message : String(error)
    console.error(`[feed] Category ${categoryId} failed:`, error)
    return c.json(
      {
        error: 'Failed to load category feed',
        code: 'FEED_ERROR',
        message
      },
      500
    )
  }
})

// --- GET /api/feed/categories ----------------------------------------------
// List all available categories (Persian names for the filter chips).
feedRoutes.get('/feed/categories', (c) => {
  const categories = getCategories()
  return c.json({
    categories: categories.map((cat) => ({
      id: cat.id,
      nameFa: cat.nameFa,
      nameEn: cat.nameEn
    }))
  })
})

// --- GET /api/feed/stats ----------------------------------------------------
// Feed cache statistics (for debugging).
feedRoutes.get('/feed/stats', (c) => {
  return c.json({
    cacheSize: feedCache.size(),
    timestamp: new Date().toISOString()
  })
})

export { feedRoutes }
