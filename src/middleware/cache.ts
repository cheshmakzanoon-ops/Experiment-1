import type { MiddlewareHandler } from 'hono'
import { memoryCache } from '../services/cache/memoryCache.js'

export interface CacheHeaderOptions {
  /** How long the browser may cache the response (seconds). */
  maxAge: number
  /** Allow stale-while-revalidate (seconds). */
  staleWhileRevalidate?: number
  /** Mark the response private (e.g. personalized data). */
  private?: boolean
}

/**
 * Sets Cache-Control headers on successful responses.
 * Useful for thumbnails, static JSON metadata, etc.
 */
export function cacheControlHeaders(options: CacheHeaderOptions): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (!c.res.ok) return
    const { maxAge, staleWhileRevalidate = 0, private: isPrivate = false } = options
    const scope = isPrivate ? 'private' : 'public'
    const parts = [`${scope}, max-age=${maxAge}`]
    if (staleWhileRevalidate > 0) {
      parts.push(`stale-while-revalidate=${staleWhileRevalidate}`)
    }
    c.header('Cache-Control', parts.join(', '))
  }
}

/**
 * Small helper for memoizing async producers behind the shared memory cache,
 * e.g. `withCache('video:x', 7_200_000, () => extractVideoInfo(x))`.
 */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  producer: () => Promise<T>
): Promise<T> {
  const cached = memoryCache.get<T>(key)
  if (cached) return cached

  const value = await producer()
  memoryCache.set(key, value, ttlMs)
  return value
}
