/**
 * Fixed-window rate limiter middleware.
 *
 * The old implementation had a design bug: every call to the middleware
 * factory created a NEW limiter while a module-level timer cleaned up an
 * unrelated default instance, so per-route limits were never enforced and
 * the maps could only grow. This version:
 *
 *   - each limiter instance owns its own cleanup (timer + lazy pruning), so
 *     stale keys cannot accumulate and no unrelated global is involved,
 *   - client identity is derived safely: X-Forwarded-For is ONLY trusted
 *     when TRUST_PROXY=true (Freebuff sits behind a reverse proxy, but a
 *     user-controlled header must never become a security boundary),
 *   - when a valid household session exists, the limit keys on the session
 *     id instead of an IP (household devices behind NAT share one IP),
 *   - responses carry an accurate `Retry-After`.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { config } from '../config.js'
import { currentSession } from './session.js'

interface Bucket {
  count: number
  resetAt: number
}

export interface RateLimitOptions {
  windowMs?: number
  max?: number
  /** Custom key; defaults to session id → client ip → 'anon'. */
  keyer?: (c: Context) => string
  name?: string
}

/** Client IP used only for anonymous (pre-session) limits. */
export function clientIp(c: Context): string | null {
  if (config.trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded) {
      const first = forwarded.split(',')[0]?.trim()
      if (first) return first
    }
    const realIp = c.req.header('x-real-ip')
    if (realIp) return realIp
  }
  // @hono/node-server exposes the raw node request on c.env.incoming (the
  // env object is absent under Hono's test harness and some runtimes).
  const env = c.env as
    | { incoming?: { socket?: { remoteAddress?: string } } }
    | undefined
  const address = env?.incoming?.socket?.remoteAddress
  if (address && !address.startsWith('::ffff:')) {
    if (address === '::1') return '127.0.0.1'
    return address
  }
  if (address) return address.slice(7)
  return null
}

const DEFAULT_KEYER = (c: Context): string => {
  const session = currentSession(c)
  if (session) return `session:${session.sid}`
  const ip = clientIp(c)
  return ip ? `ip:${ip}` : 'anon'
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private windowMs: number
  private max: number
  private keyer: (c: Context) => string
  private name: string
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private lastSweep = 0

  constructor(options: RateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000
    this.max = options.max ?? 100
    this.keyer = options.keyer ?? DEFAULT_KEYER
    this.name = options.name ?? 'rate-limit'

    // Per-instance cleanup (owned by this limiter; unref'd so it never
    // keeps the process alive). Lazy pruning also runs on writes.
    this.sweepTimer = setInterval(() => this.sweep(), 60_000)
    this.sweepTimer.unref?.()
  }

  allow(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const bucket = this.buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs })
      this.maybeSweep(now)
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (bucket.count >= this.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
      return { allowed: false, retryAfterSeconds }
    }
    bucket.count += 1
    return { allowed: true, retryAfterSeconds: 0 }
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const key = this.keyer(c)
      const decision = this.allow(key)
      if (!decision.allowed) {
        return c.json(
          { error: 'Too many requests — slow down and try again later', code: 'RATE_LIMITED' },
          429,
          { 'Retry-After': String(decision.retryAfterSeconds) }
        )
      }
      await next()
    }
  }

  /** Drop expired buckets. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(key)
    }
  }

  private maybeSweep(now: number): void {
    // Keep the write path O(1); sweep at most every 30s and only when the
    // map is meaningful in size.
    if (this.buckets.size > 2000 && now - this.lastSweep > 30_000) {
      this.lastSweep = now
      this.sweep(now)
    }
  }

  size(): number {
    return this.buckets.size
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.buckets.clear()
  }
}

/** Middleware factory with a dedicated instance (owns its own cleanup). */
export function rateLimit(options: RateLimitOptions = {}): MiddlewareHandler {
  const limiter = new RateLimiter(options)
  return limiter.middleware()
}
