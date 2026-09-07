import { Hono } from 'hono'
import { searchVideos } from '../utils/ytDlp.js'
import { memoryCache } from '../services/cache/memoryCache.js'

const searchRoutes = new Hono()

// GET /api/search
searchRoutes.get('/search', async (c) => {
  const query = c.req.query('q')
  const maxResults = parseInt(c.req.query('max') || '8')
  
  // Validate query
  if (!query || query.trim().length === 0) {
    return c.json({ error: 'Query parameter "q" is required' }, 400)
  }
  
  // Limit query length
  if (query.length > 100) {
    return c.json({ error: 'Query too long (max 100 characters)' }, 400)
  }
  
  // Validate max results
  if (maxResults < 1 || maxResults > 20) {
    return c.json({ error: 'max must be between 1 and 20' }, 400)
  }
  
  // Check cache
  const cacheKey = `search:${query.trim()}:${maxResults}`
  const cached = memoryCache.get(cacheKey)
  
  if (cached) {
    return c.json(cached)
  }
  
  try {
    // Search videos
    const results = await searchVideos(query.trim(), maxResults)
    
    // Rewrite thumbnails to the local proxy so images load for users in
    // countries where i.ytimg.com is blocked.
    const response = {
      query: query.trim(),
      results: results.map((r) => ({
        ...r,
        thumbnail: `/api/video/${r.id}/thumbnail`
      })),
      total: results.length
    }
    
    // Cache for 30 seconds
    memoryCache.set(cacheKey, response, 30000)
    
    return c.json(response)
  } catch (error: any) {
    console.error('Search failed:', error)
    
    return c.json({
      error: 'Search failed',
      message: error.message
    }, 500)
  }
})

export { searchRoutes }
