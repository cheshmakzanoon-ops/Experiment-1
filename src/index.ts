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
import { keepalive, bandwidthMonitor } from './config/freebuff.js'

const app = new Hono()

// Middleware
app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Range', 'Authorization'],
  exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges']
}))

// FreeBuff sandbox monitoring: track bytes served (from Content-Length) and
// flag slow requests. Streams relayed without a Content-Length (chunked) are
// undercounted — the numbers are a lower-bound estimate for capacity checks.
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()

  const responseLength = c.res.headers.get('content-length')
  if (responseLength) {
    bandwidthMonitor.trackBytes(parseInt(responseLength, 10))
  }

  const duration = Date.now() - start
  if (duration > 5000) {
    console.warn(`[slow] ${c.req.method} ${c.req.path} took ${duration}ms`)
  }
})

// API Routes
app.route('/api', videoRoutes)
app.route('/api', searchRoutes)
app.route('/api', streamRoutes)
app.route('/api', feedRoutes)
app.route('/api', healthRoutes)
app.route('/api', diagnosticRoutes)

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

// FreeBuff sandboxes may go idle without traffic — self-ping /api/health so
// the preview stays warm. Harmless no-op elsewhere.
keepalive.start(4)

console.log(`Server starting on http://${hostname}:${port}`)

serve({
  fetch: app.fetch,
  port: Number(port),
  hostname
})

export default app
