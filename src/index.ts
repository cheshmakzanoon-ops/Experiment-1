/**
 * FreeBuff Cloud entrypoint.
 *
 *   - validates Node ≥ 22 and fails CLOSED on every environment without
 *     ACCESS_KEY / SESSION_SECRET (never an insecure silent "allow all";
 *     AUTH_DISABLED=true works only on an explicit loopback dev binding),
 *   - initializes the persistent session store BEFORE accepting requests
 *     (corruption fails startup; a later write failure fails readiness),
 *   - verifies the pinned yt-dlp executable (same ensure script as a
 *     bounded child — also for direct `node dist/index.js` startup) before
 *     any production probing/extraction,
 *   - serves same-origin UI + API with NO wildcard CORS,
 *   - protects every /api/* route (except cheap liveness) with an HttpOnly
 *     same-origin session cookie,
 *   - adds security headers and a practical self-only CSP,
 *   - routes all expensive YouTube work through the bounded yt-dlp runner,
 *   - handles SIGTERM/SIGINT with ONE ordered, awaitable graceful shutdown:
 *     close admission → fence new spawns → drain HTTP in parallel with
 *     real child exits → clean exit (or a bounded nonzero force-exit).
 */

import { serve, type ServerType } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Hono, type Context } from 'hono'
import { assertNodeVersion, assertValidConfig, ConfigError, config } from './config.js'
import { ytDlpGate } from './services/ytdlp/queue.js'
import {
  setSpawnFence,
  terminateAllChildren,
  probeDetectedVersion
} from './services/ytdlp/runYtDlp.js'
import { authIsDisabled, currentSession } from './middleware/session.js'
import { sessionStore } from './services/sessionStore.js'
import { markShuttingDown } from './services/shutdownState.js'
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

// ---------------------------------------------------------------------------
// Startup validation (fail closed, precisely) — before ANY socket binding
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

// Apply the configured yt-dlp concurrency bounds to the shared gate ONCE,
// before any request can reach it (refuses changes while work is active).
try {
  ytDlpGate.configure({
    activeLimit: config.ytDlpConcurrency,
    queueMax: config.ytDlpQueueMax,
    queueTimeoutMs: config.ytDlpQueueTimeoutMs
  })
} catch (error) {
  console.error('[config] Could not configure the yt-dlp gate:')
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

// Persistent active-session allowlist — initialize before accepting
// requests. A corrupt store fails startup; never silently replaced.
async function initializeSessionStore(): Promise<void> {
  if (authIsDisabled()) return // loopback dev mode: no session enforcement
  try {
    await sessionStore.initialize()
    console.log('[auth] Session store ready.')
  } catch (error) {
    console.error('[auth] Session store initialization failed:')
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}

/**
 * Direct startup (and `npm start`) verifies the pinned executable through
 * the SAME ensure script, as a bounded child, BEFORE any probing or
 * production extraction. `prestart` already ran it under npm; the child is
 * idempotent (receipt re-hash + version check, no re-download).
 */
function ensureRuntimeAtBoot(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL('../scripts/ensure-runtime.mjs', import.meta.url))
    const child = execFile(
      process.execPath,
      [script, '--quiet'],
      { timeout: 240_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || stdout || '').toString().trim().slice(0, 800)
          reject(
            new Error(
              `Runtime verification failed (${(error as NodeJS.ErrnoException).code || error.message})${detail ? `: ${detail}` : ''}`
            )
          )
          return
        }
        resolve()
      }
    )
    // Never let the ensure child hold the process open past its timeout.
    child.unref?.()
  })
}

await initializeSessionStore()
console.log('[runtime] Verifying the pinned yt-dlp executable...')
try {
  await ensureRuntimeAtBoot()
  console.log('[runtime] yt-dlp verification passed.')
} catch (error) {
  console.error('[runtime] ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}
// Warm the detected version once so extraction args (e.g. --js-runtimes)
// are built from the DETECTED executable, and readiness is honest.
await probeDetectedVersion(true).catch(() => null)

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

app.use('/api/feed/stats', apiLimiter.middleware())
app.use('/api/stream/stats', apiLimiter.middleware())

app.use('/api/video/*', async (c, next) => {
  const limiter = c.req.path.endsWith('/thumbnail') ? apiLimiter : extractLimiter
  return limiter.middleware()(c, next)
})

app.use('/api/search', extractLimiter.middleware())
app.use('/api/feed/home', extractLimiter.middleware())
app.use('/api/feed/category/*', extractLimiter.middleware())

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
  console.warn('[auth] Session enforcement DISABLED (explicit loopback-only development mode).')
}

console.log(`Server starting on http://${hostname}:${port}`)

const server: ServerType = serve({
  fetch: app.fetch,
  port,
  hostname
})

// ---------------------------------------------------------------------------
// Ordered, awaitable graceful shutdown
// ---------------------------------------------------------------------------

const SHUTDOWN_GRACE_MS = 10_000
let shuttingDown = false
let forceTimer: ReturnType<typeof setTimeout> | null = null

async function shutdownSequence(): Promise<void> {
  // Terminate active children AND await their REAL exits (close), in
  // parallel with bounded HTTP draining. Do not exit merely because
  // server.close fired while children remain alive.
  const childrenDone = terminateAllChildren(8000)
  const httpDrained = new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  await Promise.allSettled([childrenDone, httpDrained])
}

function shutdown(signal: string): void {
  if (shuttingDown) return // repeated signals never duplicate timers/loops
  shuttingDown = true
  markShuttingDown()
  console.log(`[shutdown] ${signal} received — draining`)

  keepalive.stop()

  // 1. Close yt-dlp admission (queued jobs rejected NOW, their timers
  // cleared) and raise the runner-level no-new-spawns fence (also blocks
  // bypassQueue version probes).
  ytDlpGate.abortQueued('Server is shutting down')
  setSpawnFence(true)

  const cleanup = shutdownSequence()

  // Bounded overall grace: at the deadline force remaining children and
  // sockets closed and exit NON-ZERO (never report a clean exit).
  forceTimer = setTimeout(() => {
    console.error('[shutdown] Grace period elapsed — forcing remaining sockets/children closed')
    try {
      const http = (server as unknown as { closeAllConnections?: () => void })
      http.closeAllConnections?.()
    } catch {
      /* best effort */
    }
    void terminateAllChildren(1000)
    process.exit(1)
  }, SHUTDOWN_GRACE_MS)
  forceTimer.unref()

  void cleanup.then(
    () => {
      if (forceTimer) clearTimeout(forceTimer)
      forceTimer = null
      console.log('[shutdown] Clean exit')
      process.exit(0)
    },
    (error) => {
      console.error('[shutdown] Drain failed:', error)
      process.exit(1)
    }
  )
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

export default app

// Re-export used pieces so tooling/tests can reuse the same instances.
export { clientIp }
