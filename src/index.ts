import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { videoRoutes } from './routes/videoRoutes.js'
import { searchRoutes } from './routes/searchRoutes.js'
import { streamRoutes } from './routes/streamRoutes.js'
import { feedRoutes } from './routes/feedRoutes.js'
import { healthRoutes } from './routes/healthRoutes.js'
import { diagnosticRoutes } from './routes/diagnosticRoutes.js'
import { configRoutes } from './routes/configRoutes.js'
import { authMiddleware } from './middleware/auth.js'
import { streamByteCounter } from './middleware/streamByteCounter.js'
import { poTokenService } from './services/potoken/generator.js'
import { keepalive, bandwidthMonitor } from './config/freebuff.js'

const app = new Hono()

// Middleware — order matters:
//   1. logger()          request logging
//   2. cors()            CORS headers (+ preflight short-circuit)
//   3. authMiddleware    API-key check on every /api/* request
//   4. bandwidth tracker (non-stream responses, Content-Length)
//   5. stream byte counter (/api/stream/* wrapped bodies)
app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Range', 'Authorization', 'X-API-Key'],
  exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']
}))

// API authentication — protects every /api/* endpoint except the small
// public set (health/config/thumbnails) declared in src/middleware/auth.ts.
// Registered after CORS so OPTIONS preflights keep working without a key.
app.use('/api/*', authMiddleware)

// FreeBuff sandbox monitoring: flag slow requests and count bytes of
// non-stream responses via their Content-Length. Streaming responses are
// owned by the streamByteCounter below, which counts actual bytes flowing
// through the relay (chunked streams have no Content-Length at all).
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
  if (duration > 5000) {
    console.warn(`[slow] ${c.req.method} ${c.req.path} took ${duration}ms`)
  }
})

// Accurate bandwidth accounting for media relays (exact bytes served, incl.
// chunked streams and early client disconnects).
app.use('/api/stream/*', streamByteCounter({
  onBytes: (bytes) => bandwidthMonitor.trackBytes(bytes)
}))

// API Routes
app.route('/api', videoRoutes)
app.route('/api', searchRoutes)
app.route('/api', streamRoutes)
app.route('/api', feedRoutes)
app.route('/api', healthRoutes)
app.route('/api', diagnosticRoutes)
app.route('/api', configRoutes)

// Serve frontend. Resolve relative to this module so it works from both
// src/ (tsx dev) and dist/ (node start).
const frontendRoot = fileURLToPath(new URL('../src/frontend', import.meta.url))

// Explicit index route so GET / always returns index.html
app.get('/', async (c) => {
  try {
    const html = await readFile(`${frontendRoot}/index.html`, 'utf8')
    return c.html(html)
  } catch {
    return c.text('Frontend not found', 500)
  }
})

// Static assets (css, js, images)
app.use('*', serveStatic({ root: frontendRoot }))

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Endpoint not found' }, 404)
})

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: 'Internal server error' }, 500)
})

const port = process.env.PORT || 3000
const hostname = process.env.HOST || '0.0.0.0'

// FreeBuff sandboxes may go idle without traffic — ping /api/health (and an
// external host for real egress traffic) so the preview stays warm.
// Harmless no-op elsewhere.
keepalive.start(4)

// Start the PO-token auto-refresh loop. Best-effort: without the provider
// installed it logs a warning and continues — extraction just runs without
// a token (YouTube may block datacenter IPs until one is configured).
try {
  poTokenService.startAutoRefresh()
} catch (error) {
  console.error('[potoken] Failed to start auto-refresh:', error)
  console.error('[potoken] YouTube requests may be blocked without a PO token')
}

console.log(`Server starting on http://${hostname}:${port}`)

serve({
  fetch: app.fetch,
  port: Number(port),
  hostname
})

export default app
