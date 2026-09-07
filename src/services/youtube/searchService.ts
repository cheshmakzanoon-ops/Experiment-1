import { searchVideos } from '../../utils/ytDlp.js'
import { memoryCache } from '../cache/memoryCache.js'
import { config } from '../../config.js'
import type { SearchResult } from '../../types/video.js'

export interface SearchOptions {
  useCache?: boolean
  ttlMs?: number
}

/**
 * High-level YouTube search. The low-level util returns results whose
 * thumbnails point directly at i.ytimg.com — rewrite them to our proxy
 * route so thumbnails load even where YouTube image hosts are blocked.
 */
export function thumbnailProxyUrl(videoId: string): string {
  return `/api/video/${videoId}/thumbnail`
}

/**
 * Search videos and return results ready for the Persian UI.
 */
export async function searchForVideos(
  query: string,
  maxResults: number = 8,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { useCache = true, ttlMs = config.cache.searchTtlMs } = options
  const cacheKey = `search:${query}:${maxResults}`

  if (useCache) {
    const cached = memoryCache.get<SearchResult[]>(cacheKey)
    if (cached) return cached
  }

  const results = await searchVideos(query, maxResults)
  const proxied = results.map((r) => ({
    ...r,
    thumbnail: r.thumbnail ? thumbnailProxyUrl(r.id) : ''
  }))

  if (useCache) {
    memoryCache.set(cacheKey, proxied, ttlMs)
  }

  return proxied
}
