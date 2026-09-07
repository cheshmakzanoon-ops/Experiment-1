import type { Context, Next } from 'hono'
import { timingSafeEqual } from 'node:crypto'

/**
 * API Key authentication middleware.
 *
 * Validates that every /api/* request includes a valid API key. The key can
 * be provided via:
 *   - Query parameter:     ?key=YOUR_KEY          (needed for <video>/<img>)
 *   - Header:              X-API-Key: YOUR_KEY
 *   - Authorization header: Authorization: Bearer YOUR_KEY
 *
 * The expected key is read from the API_KEY environment variable. When it is
 * unset, authentication is disabled with a one-time console warning — that is
 * the "dev mode" fallback so the server still works before the operator has
 * configured a key. Public endpoints (health checks, first-run config, and
 * the thumbnail relay that <img> tags cannot send headers for) bypass auth.
 */

// Public endpoints that don't require auth. Kept intentionally small:
// liveness/readiness (container + keepalive), the frontend bootstrap config,
// and proxied thumbnails (<img> elements cannot send custom headers).
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/health/live',
  '/api/health/ready',
  '/api/config'
])

// GET /api/video/:id/thumbnail — proxied i.ytimg.com images rendered by
// <img> tags across the UI (home feed, search, library, …). Public on
// purpose: it only relays public, 24h-cached thumbnail JPEGs, and images
// cannot carry an API key header.
const PUBLIC_THUMBNAIL_RE = /^\/api\/video\/[A-Za-z0-9_-]{11}\/thumbnail$/

function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true
  return PUBLIC_THUMBNAIL_RE.test(path)
}

function getApiKey(): string | null {
  return process.env.API_KEY || null
}

function extractApiKey(c: Context): string | null {
  // 1. Query parameter (?key=... — used by <video> streams).
  const queryKey = c.req.query('key')
  if (queryKey) return queryKey

  // 2. X-API-Key header.
  const headerKey = c.req.header('x-api-key')
  if (headerKey) return headerKey

  // 3. Authorization: Bearer <key>.
  const authHeader = c.req.header('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7)
  }

  return null
}

/** Constant-time comparison so a wrong key does not leak via timing. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

let warnedOnce = false

export async function authMiddleware(c: Context, next: Next) {
  const apiKey = getApiKey()

  // No API key configured → warn once and allow (dev mode).
  if (!apiKey) {
    if (!warnedOnce) {
      console.warn('[auth] API_KEY not set — running in insecure dev mode!')
      console.warn('[auth] Set API_KEY in the environment before deploying to production.')
      warnedOnce = true
    }
    await next()
    return
  }

  // Public endpoints bypass auth.
  if (isPublicPath(c.req.path)) {
    await next()
    return
  }

  const providedKey = extractApiKey(c)

  if (!providedKey) {
    return c.json(
      {
        error: 'API key required',
        code: 'AUTH_MISSING',
        hint: 'Include ?key=YOUR_KEY or an X-API-Key: YOUR_KEY header'
      },
      401
    )
  }

  if (!safeEqual(providedKey, apiKey)) {
    return c.json({ error: 'Invalid API key', code: 'AUTH_INVALID' }, 401)
  }

  await next()
}
