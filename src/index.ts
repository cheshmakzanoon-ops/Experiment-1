/**
 * FreeBuff Cloud entrypoint.
 *
 *   - validates Node ≥ 22 and fails CLOSED on production without
 *     ACCESS_KEY / SESSION_SECRET (never an insecure silent "allow all"),
 *   - serves same-origin UI + API with NO wildcard CORS,
 *   - protects every /api/* route (except cheap liveness) with an HttpOnly
 *     same-origin session cookie,
 *   - adds security headers and a practical self-only CSP,
 *   - routes all expensive YouTube work through the bounded yt-dlp runner,
 *   - handles SIGTERM/SIGINT with bounded graceful shutdown.
 */

import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Hono, type Context } from 'hono'
import { assertNodeVersion, assertValidConfig, ConfigError, config } from './config.js'
import { configureGateFromConfig } from './services/ytdlp/queue.js'
import { terminateAllChildren } from './services/ytdlp/runYtDlp.js'
import { authIsDisabled } from './middleware/session.js'
import { clientIp, RateLimiter } from './middleware/rateLimit.js'
import { streamByteCounter } from './middleware/streamByteCounter.js'
import { bandwidthMonitor, keepalive } from './config/freebuff.js'
import { videoRoutes } from './routes/videoRoutes.js'
import { searchRoutes } from './routes/searchRoutes.js'
import { streamRoutes } from './routes/streamRoutes.js'
import { feedRoutes } from './routes/feedRoutes.js'
import { healthRoutes } from './routes/healthRoutes.js'
import { diagnosticRoutes } from './routes/diagnosticRoutes.js'
import { sessionRoutes } from './routes/sessionRoutes.js'
import { currentSession } from './middleware/session.js'

// ---------------------------------------------------------------------------
// Startup validation (fail closed, precisely)
// ---------------------------------------------------------------------------

try {
  assertNodeVersion()
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
}

try {
  assertValidConfig()
} catch (error) {
  console.error('[config] Startup configuration invalid:')
  console.error(error instanceof ConfigError ? error.message : error)
  process.exit(1)
}

// Apply the configured yt-dlp concurrency bounds to the shared gate.
configureGateFromConfig(config.ytDlpConcurrency, config.ytDlpQueueMax, config.ytDlpQueueTimeoutMs)

const app = new Hono()

// ---------------------------------------------------------------------------
// Rate limiter instances (each owns its cleanup — no cross-instance bug)
// ---------------------------------------------------------------------------

/** Moderate limit for ordinary JSON/thumbnail traffic. */
const apiLimiter = new RateLimiter({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  name: 'api'
})

/** Low limit for calls that can trigger an extraction. */
const extractLimiter = new RateLimiter({
  windowMs: config.rateLimit.extractWindowMs,
  max: config.rateLimit.extractMax,
  name: 'extract'
})

// ---------------------------------------------------------------------------
// Request logging + request id (structured, query-free, stream-aware)
// ---------------------------------------------------------------------------

function logRequest(c: Context, startedAt: number): void {
  const isStream = c.req.path.startsWith('/api/stream')
  const isApi = c.req.path.startsWith('/api/')
  if (!isApi && c.req.path !== '/') return // assets are too noisy
  if (isStream) {
    // Streaming requests are measured in bytes/duration separately; a long
    // relay is not an API latency bug.
    const duration = Date.now() - startedAt
    if (c.res.status >= 400) {
      console.warn(
        JSON.stringify({
          time: new Date().toISOString(),
          level: 'warn',
          reqId: c.res.headers.get('x-request-id') || '-',
          event: 'stream_request',
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          ms: duration
        })
      )
    }
    return
  }
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'info',
      reqId: c.res.headers.get('x-request-id') || '-',
      event: 'request',
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - startedAt
    })
  )
}

app.use('*', async (c, next) => {
  const startedAt = Date.now()
  const reqId = randomUUID().slice(0, 8)
  c.header('X-Request-Id', reqId)
  await next()
  logRequest(c, startedAt)
})

// ---------------------------------------------------------------------------
// Security headers (same-origin, no wildcard CORS)
// ---------------------------------------------------------------------------

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'"
].join('; ')

app.use('*', async (c, next) => {
  await next()
  const headers = c.res.headers
  if (!headers.has('X-Content-Type-Options')) headers.set('X-Content-Type-Options', 'nosniff')
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'no-referrer')
  if (!headers.has('Permissions-Policy')) {
    headers.set(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)'
    )
  }
  if (!headers.has('X-Frame-Options')) headers.set('X-Frame-Options', 'DENY')
  if (!headers.has('Content-Security-Policy')) headers.set('Content-Security-Policy', CSP)
})

// ---------------------------------------------------------------------------
// Bandwidth accounting for JSON responses (streams handled separately)
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  if (!c.req.path.startsWith('/api/stream')) {
    const responseLength = c.res.headers.get('content-length')
    if (responseLength) {
      bandwidthMonitor.trackBytes(parseInt(responseLength, 10))
    }
  }
  const duration = Date.now() - start
  if (duration > 5000 && !c.req.path.startsWith('/api/stream')) {
    console.warn(`[slow] ${c.req.method} ${c.req.path} took ${duration}ms`)
  }
})

// Stream bytes: exact wrap counting for /api/stream relays.
app.use('/api/stream/*', streamByteCounter({ onBytes: (bytes) => bandwidthMonitor.trackBytes(bytes) }))

// ---------------------------------------------------------------------------
// Public routes: liveness + session lifecycle only
// ---------------------------------------------------------------------------

app.route('/api', healthRoutes)
app.route('/api', sessionRoutes)

// ---------------------------------------------------------------------------
// Session gate over the rest of /api/*
// ---------------------------------------------------------------------------

function isPublicApiPath(path: string): boolean {
  return (
    path === '/api/health' ||
    path === '/api/health/live' ||
    path === '/api/health/ready' ||
    path.startsWith('/api/session')
  )
}

app.use('/api/*', async (c, next) => {
  if (isPublicApiPath(c.req.path)) {
    await next()
    return
  }
  if (authIsDisabled()) {
    await next()
    return
  }
  const session = currentSession(c)
  if (!session) {
    return c.json({ error: 'Authentication required', code: 'AUTH_REQUIRED' }, 401, {
      'WWW-Authenticate': 'Session'
    })
  }
  c.header('x-session-id', session.sid)
  await next()
})

// ---------------------------------------------------------------------------
// Rate limiting by class (session/ip keyed; Retry-After returned)
// ---------------------------------------------------------------------------

// Moderate limit: ordinary metadata/feed/thumbnail/stats traffic.
app.use('/api/feed/stats', apiLimiter.middleware())
app.use('/api/stream/stats', apiLimiter.middleware())

// Video metadata triggers extraction; thumbnails never do. Both share the
// /api/video/* tree, so branch on the suffix instead of double-mounting.
app.use('/api/video/*', async (c, next) => {
  const limiter = c.req.path.endsWith('/thumbnail') ? apiLimiter : extractLimiter
  return limiter.middleware()(c, next)
})

// Low limit: calls that can trigger yt-dlp extraction work.
app.use('/api/search', extractLimiter.middleware())
app.use('/api/feed/home', extractLimiter.middleware())
app.use('/api/feed/category/*', extractLimiter.middleware())

// /api/diag/* is additionally gated inside diagnosticRoutes.ts (disabled by
// default; its own strict limiter when enabled).

// /api/stream/* is NOT request-count limited: stream requests are repeated
// byte-range reads whose cost is bounded by the yt-dlp gate/cache, not by
// request count (see section 6 of the hardening brief).

// ---------------------------------------------------------------------------
// Protected API routes
// ---------------------------------------------------------------------------

app.route('/api', videoRoutes)
app.route('/api', searchRoutes)
app.route('/api', streamRoutes)
app.route('/api', feedRoutes)
app.route('/api', diagnosticRoutes)

// ---------------------------------------------------------------------------
// Frontend (same origin; the whole critical UI lives here)
// ---------------------------------------------------------------------------

const frontendRoot = fileURLToPath(new URL('../src/frontend', import.meta.url))

app.get('/', async (c) => {
  try {
    const html = await readFile(`${frontendRoot}/index.html`, 'utf8')
    return c.html(html)
  } catch {
    return c.text('Frontend not found', 500)
  }
})

app.use('*', serveStatic({ root: frontendRoot }))

// ---------------------------------------------------------------------------
// Errors + 404
// ---------------------------------------------------------------------------

app.notFound((c) => {
  return c.json({ error: 'Endpoint not found' }, 404)
})

app.onError((err, c) => {
  console.error(
    JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      event: 'unhandled_error',
      path: c.req.path,
      message: err instanceof Error ? err.message : String(err)
    })
  )
  return c.json({ error: 'Internal server error' }, 500)
})

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const hostname = config.host
const port = config.port

// Optional keepalive experiment (off by default; unref'd; see freebuff.ts).
keepalive.start()

if (authIsDisabled()) {
  console.warn('[auth] Session enforcement DISABLED (development mode).')
  console.warn('[auth]   Set ACCESS_KEY + SESSION_SECRET (and NODE_ENV=production) to protect the proxy.')
}

console.log(`Server starting on http://${hostname}:${port}`)

const server: ServerType = serve({
  fetch: app.fetch,
  port,
  hostname
})

// ---------------------------------------------------------------------------
// Bounded graceful shutdown
// ---------------------------------------------------------------------------

const SHUTDOWN_GRACE_MS = 10_000
let shuttingDown = false

function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[shutdown] ${signal} received — draining`)

  keepalive.stop()

  // Stop accepting new expensive work and terminate yt-dlp children.
  terminateAllChildren()

  // Let active responses finish within a bounded grace period.
  const forceTimer = setTimeout(() => {
    console.error('[shutdown] Grace period elapsed — forcing exit')
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)
  forceTimer.unref()

  server.close(() => {
    clearTimeout(forceTimer)
    console.log('[shutdown] Clean exit')
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app

// Re-export used pieces so tooling/tests can reuse the same instances.
export { clientIp }
