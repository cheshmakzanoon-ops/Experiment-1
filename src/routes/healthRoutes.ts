/**
 * Public platform health endpoints (the only unauthenticated API routes).
 *
 *   GET /api/health/live   — process/event-loop liveness (extremely cheap)
 *   GET /api/health        — compatible alias of the above
 *   GET /api/health/ready  — local runtime prerequisites, cached 45 s
 *
 * Readiness verifies CONFIGURATION + NODE + session storage + yt-dlp
 * executable + EXACT pinned-version match + supported JS runtime. It
 * deliberately performs NO YouTube extraction: "the runtime is present"
 * must never be confused with "YouTube is not blocking this IP right now" —
 * that distinction lives in the protected diagnostics
 * (see src/services/diagnostics.ts). Once shutdown begins, readiness
 * immediately answers 503 SHUTTING_DOWN before consulting any cached
 * result.
 */

import { Hono } from 'hono'
import { assertNodeVersion, assertValidConfig, ConfigError, config, NODE_VERSION_MIN } from '../config.js'
import { checkRuntimeHealth } from '../services/ytdlp/runYtDlp.js'
import { describeRuntimeState } from '../services/ytdlp/runtime.js'
import { MIN_EJS_RUNTIME_VERSION } from '../services/ytdlp/runtime.js'
import { authIsDisabled } from '../middleware/session.js'
import { sessionStore } from '../services/sessionStore.js'
import { isShuttingDown } from '../services/shutdownState.js'

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
  // 1. Configuration valid (secrets present, env recognized, auth setting
  // strict — production fails closed without credentials).
  try {
    assertValidConfig()
  } catch (error) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: 'CONFIG_INVALID'
    }
  }

  // 2. Node runtime acceptable.
  try {
    assertNodeVersion()
  } catch (error) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: 'NODE_TOO_OLD'
    }
  }

  // 2.5. Session storage healthy when sessions are enforced (a failed
  // write fails readiness closed until recovery/restart).
  if (!authIsDisabled() && !sessionStore.isHealthy()) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: 'AUTH_STORAGE_UNAVAILABLE'
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

  // 6. EXACT requested-version match — the pinned/requested release is the
  // contract (managed binary AND explicit YT_DLP_PATH). A mismatch is NOT
  // ready; it is never a warning attached to success.
  const requested = config.ytDlpVersion.trim()
  const detected = (runtime.version || '').trim()
  if (detected !== requested) {
    return {
      status: 'not_ready',
      checkedAt: Date.now(),
      reason: 'YTDLP_VERSION_MISMATCH',
      detail: {
        nodeVersion: process.version,
        ytDlpMode: state.mode,
        ytDlpDetectedVersion: runtime.version,
        jsRuntime: runtime.jsRuntime
      }
    }
  }

  return {
    status: 'ready',
    checkedAt: Date.now(),
    detail: {
      nodeVersion: process.version,
      ytDlpMode: state.mode,
      ytDlpDetectedVersion: runtime.version,
      jsRuntime: runtime.jsRuntime
    }
  }
}

// GET /api/health/ready — cached local prerequisite check (no extraction).
healthRoutes.get('/health/ready', async (c) => {
  // Shutdown short-circuits EVERYTHING, including the cached success.
  if (isShuttingDown()) {
    return c.json({ status: 'not_ready', reason: 'SHUTTING_DOWN' }, 503)
  }
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
