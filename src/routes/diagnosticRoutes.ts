/**
 * Diagnostics routes — DISABLED unless ENABLE_DIAGNOSTICS=true.
 *
 * When enabled they sit behind the household session, an extremely strict
 * rate limit, and a single-flight deep-operation gate with cooldowns.
 * Everything is answered by direct function calls (never by HTTP calls back
 * into this server's own API) and responses are sanitized: no raw yt-dlp
 * stderr, no tokens/cookies/proxy credentials, and media URLs redacted to
 * hostname + path type.
 *
 *   GET /api/diag/status         — runtime/egress/caches/sandbox snapshot
 *   GET /api/diag/connectivity   — deep test: extraction + CDN byte fetch
 */

import { Hono } from 'hono'
import { config } from '../config.js'
import { isValidVideoId } from '../utils/urlValidator.js'
import { SUPPORTED_QUALITIES } from '../services/youtube/extractor.js'
import { parseParam } from '../utils/params.js'
import { RateLimiter } from '../middleware/rateLimit.js'
import { buildStatusReport, runConnectivityCheck, withDeepDiagnostic, diagGateStatus } from '../services/diagnostics.js'

const diagnosticRoutes = new Hono()

// Extremely strict per-client limiter for diagnostics.
const diagLimiter = new RateLimiter({
  windowMs: config.rateLimit.diagWindowMs,
  max: config.rateLimit.diagMax,
  name: 'diag'
})

/** All /api/diag/* endpoints 404 when diagnostics are disabled. */
diagnosticRoutes.use('/diag/*', async (c, next) => {
  if (!config.enableDiagnostics) {
    return c.json({ error: 'Endpoint not found' }, 404)
  }
  return diagLimiter.middleware()(c, next)
})

// GET /api/diag/status — cheap-ish snapshot (no extraction).
diagnosticRoutes.get('/diag/status', async (c) => {
  const report = await buildStatusReport()
  return c.json({
    timestamp: new Date().toISOString(),
    ...report
  })
})

// GET /api/diag/connectivity?v=ID&quality=240 — deep test (extraction + CDN).
diagnosticRoutes.get('/diag/connectivity', async (c) => {
  if (diagGateStatus() === 'running') {
    return c.json({ error: 'A diagnostic is already running', code: 'DIAG_BUSY' }, 503, { 'Retry-After': '10' })
  }

  const videoId = c.req.query('v') || 'dQw4w9WgXcQ'
  if (!isValidVideoId(videoId)) {
    return c.json({ error: 'Invalid video ID', code: 'INVALID_ID' }, 400)
  }
  const qualityRaw = c.req.query('quality') || '240'
  if (!(SUPPORTED_QUALITIES as readonly string[]).includes(qualityRaw)) {
    return c.json(
      { error: `Invalid quality. Must be one of: ${SUPPORTED_QUALITIES.join(', ')}`, code: 'INVALID_QUALITY' },
      400
    )
  }
  const quality = parseInt(qualityRaw, 10)

  try {
    const report = await withDeepDiagnostic(() => runConnectivityCheck(videoId, quality))
    return c.json(report)
  } catch (error) {
    const err = error as Error & { status?: number; retryAfter?: number }
    return c.json(
      { error: err.message, code: err.status === 503 ? 'DIAG_BUSY' : 'DIAG_ERROR' },
      err.status === 503 ? 503 : 500,
      err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : undefined
    )
  }
})

export { diagnosticRoutes }
