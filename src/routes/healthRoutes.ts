/**
 * Public platform health endpoints (the only unauthenticated API routes).
 *
 *   GET /api/health/live   — process/event-loop liveness (extremely cheap)
 *   GET /api/health        — compatible alias of the above
 *   GET /api/health/ready  — local runtime prerequisites, cached 45 s
 *
 * Readiness verifies CONFIGURATION + NODE + yt-dlp executable + version +
 * supported JS runtime. It deliberately performs NO YouTube extraction:
 * "the runtime is present" must never be confused with "YouTube is not
 * blocking this IP right now" — that distinction lives in the protected
 * diagnostics (see src/services/diagnostics.ts).
 */

import { Hono } from 'hono'
import { assertNodeVersion, assertValidConfig, ConfigError, config, NODE_VERSION_MIN } from '../config.js'
import { checkRuntimeHealth } from '../services/ytdlp/runYtDlp.js'
import { compareYtDlpVersions, describeRuntimeState } from '../services/ytdlp/runtime.js'
import { MIN_EJS_RUNTIME_VERSION } from '../services/ytdlp/runtime.js'

const healthRoutes = new Hono()

interface LiveResponse {
  status: 'ok'
  uptime: number
  timestamp: string
}

// GET /api/health/live — answers whether the process is alive.
healthRoutes.get('/health/live', (c) => {
  const body: LiveResponse = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  }
  return c.json(body)
})

// GET /api/health — compatible alias kept for existing clients.
healthRoutes.get('/health', (c) => {
  const memoryUsage = process.memoryUsage()
  return c.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: {
      used: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      total: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memoryUsage.rss / 1024 / 1024)
    },
    node_version: process.version
  })
})

// --- Readiness (cached) -----------------------------------------------------

interface ReadinessState {
  status: 'ready' | 'not_ready'
  checkedAt: number
  reason?: string
  detail?: {
    nodeVersion: string
    ytDlpMode: string
    ytDlpDetectedVersion: string | null
    jsRuntime: string | null
  }
}

const READY_CACHE_TTL_MS = 45_000

let readinessCache: ReadinessState | null = null

async function computeReadiness(): Promise<ReadinessState> {
  // 1. Configuration valid (secrets present in production etc.).
  try {
    assertValidConfig()
  } catch (error) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: error instanceof ConfigError ? 'CONFIG_INVALID' : 'CONFIG_INVALID'
    }
  }

  // 2. Node runtime acceptable.
  try {
    assertNodeVersion()
  } catch (error) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: error instanceof ConfigError ? 'NODE_TOO_OLD' : 'NODE_TOO_OLD'
    }
  }

  // 3–5. yt-dlp resolves, --version works, and the JS runtime flag is
  // supported by the detected version.
  const runtime = await checkRuntimeHealth()
  const state = describeRuntimeState()

  if (!runtime.ok) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: runtime.problem === 'version_too_old' ? 'YTDLP_VERSION_TOO_OLD' : 'RUNTIME_MISSING',
      detail: {
        nodeVersion: process.version,
        ytDlpMode: state.mode,
        ytDlpDetectedVersion: runtime.version,
        jsRuntime: runtime.jsRuntime
      }
    }
  }

  // Warn but do not fail when the installed version differs from the pinned
  // one — the pinned version is a floor for EJS support.
  const pinned = config.ytDlpVersion
  const belowPin = compareYtDlpVersions(runtime.version || '', pinned) < 0

  return {
    status: 'ready',
    checkedAt: Date.now(),
    detail: {
      nodeVersion: process.version,
      ytDlpMode: state.mode,
      ytDlpDetectedVersion: runtime.version,
      jsRuntime: runtime.jsRuntime
    },
    ...(belowPin ? { reason: 'BELOW_PINNED_VERSION' } : {})
  }
}

// GET /api/health/ready — cached local prerequisite check (no extraction).
healthRoutes.get('/health/ready', async (c) => {
  const now = Date.now()
  if (!readinessCache || now - readinessCache.checkedAt > READY_CACHE_TTL_MS) {
    readinessCache = await computeReadiness()
  }

  if (readinessCache.status !== 'ready') {
    return c.json(
      {
        status: 'not_ready',
        reason: readinessCache.reason,
        detail: readinessCache.detail ?? undefined
      },
      503
    )
  }

  const detail = readinessCache.detail
  return c.json({
    status: 'ready',
    node: detail?.nodeVersion,
    ytDlp: {
      mode: detail?.ytDlpMode,
      version: detail?.ytDlpDetectedVersion,
      minimumVersion: MIN_EJS_RUNTIME_VERSION,
      pinnedVersion: config.ytDlpVersion,
      jsRuntime: detail?.jsRuntime
    }
  })
})

export { healthRoutes }
