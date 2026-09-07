import type { MiddlewareHandler } from 'hono'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

interface RateLimiterOptions {
  windowMs?: number
  maxRequests?: number
}

class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>()

  constructor(
    public windowMs: number = config.rateLimit.windowMs,
    public maxRequests: number = config.rateLimit.maxRequests
  ) {}

  /** Returns true when the request for `key` is allowed. */
  allow(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs
    const recent = (this.hits.get(key) || []).filter((t) => t > cutoff)
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  /** Periodically drop expired entries so the map cannot grow unbounded. */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs
    for (const [key, timestamps] of this.hits.entries()) {
      const recent = timestamps.filter((t) => t > cutoff)
      if (recent.length === 0) this.hits.delete(key)
      else this.hits.set(key, recent)
    }
  }
}

const defaultLimiter = new SlidingWindowRateLimiter()

/** Periodically prune expired windows (every 5 minutes). */
setInterval(() => {
  defaultLimiter.cleanup()
}, 300000).unref()

function clientKey(c: Parameters<MiddlewareHandler>[0]): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0].trim()
    if (first) return first
  }
  return c.req.header('x-real-ip') || 'unknown'
}

/**
 * Sliding-window rate limiter middleware.
 * Limits are per-IP and read from RATE_LIMIT_WINDOW / RATE_LIMIT_MAX_REQUESTS.
 */
export function rateLimit(options: RateLimiterOptions = {}): MiddlewareHandler {
  const limiter = new SlidingWindowRateLimiter(
    options.windowMs ?? config.rateLimit.windowMs,
    options.maxRequests ?? config.rateLimit.maxRequests
  )

  return async (c, next) => {
    const key = clientKey(c)
    if (!limiter.allow(key)) {
      logger.warn('Rate limit exceeded', { key })
      return c.json(
        { error: 'Too many requests, please try again later' },
        429,
        { 'Retry-After': String(Math.ceil(limiter.windowMs / 1000)) }
      )
    }
    await next()
  }
}
